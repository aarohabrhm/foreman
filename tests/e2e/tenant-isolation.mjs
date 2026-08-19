/**
 * Cross-organization isolation test, run against real accounts.
 *
 *   npm run test:isolation
 *
 * Signs in as a genuine Org B user and attacks Org A by ID: reading, listing,
 * subscribing, triggering, approving and writing. Inspecting the permission
 * rules is not the same as proving them, so every assertion here goes through
 * the same public GraphQL endpoint the app uses.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "graphql-ws";

import { signIn, userGraphql } from "../../scripts/lib/auth.mjs";
import { adminGraphql, metadataApi } from "../../scripts/lib/hasura.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const results = [];

/**
 * A check that goes through a Hasura Action only proves something about
 * permissions if the request actually reached the permission check. Two ways it
 * might not, both of which would otherwise look like a pass:
 *
 *   1. the Actions are not in the schema at all (ACTION_BASE_URL unset), or
 *   2. they are, but Hasura cannot reach the handler (the app is not deployed,
 *      or is deployed wrongly), so the mutation fails on the webhook call.
 *
 * Either way the caller was refused for the wrong reason, so it is reported as
 * inconclusive. tests/e2e/run-lifecycle.mjs covers the same denials meanwhile
 * by calling the handlers directly.
 *
 * Note that a *missing field* is not automatically a gap: once the Actions are
 * in the schema, "no mutations exist" for `viewer` means the Action's own
 * permissions exclude that role, which is the enforcement working.
 */
let actionsInSchema = false;

const classify = (detail) => {
  const text = detail ?? "";
  if (/webhook/i.test(text)) return "handler-unreachable";
  if (
    !actionsInSchema &&
    (/field '(triggerWorkflowRun|approveStep|saveWorkflow|startWorkflowViaWebhook)' not found/i.test(
      text,
    ) ||
      /no mutations exist/i.test(text))
  ) {
    return "action-missing";
  }
  return null;
};

const record = (name, passed, detail = "", { viaAction = false } = {}) => {
  const gap = passed && viaAction ? classify(detail) : null;
  results.push({ name, passed, detail, inconclusive: Boolean(gap), gap });
  const label = gap ? "SKIP" : passed ? "PASS" : "FAIL";
  console.log(`  ${label}  ${name}${detail ? ` — ${detail}` : ""}`);
};

/** Are the Actions actually part of the GraphQL schema right now? */
async function detectActions() {
  try {
    const state = await metadataApi("get_inconsistent_metadata", {});
    const inconsistentNames = new Set(
      (state?.inconsistent_objects ?? []).map((entry) => entry.name ?? ""),
    );
    const metadata = await metadataApi("export_metadata", {});
    const defined = (metadata.actions ?? []).map((action) => action.name);
    return (
      defined.includes("triggerWorkflowRun") &&
      ![...inconsistentNames].some((name) => name.includes("triggerWorkflowRun"))
    );
  } catch {
    return false;
  }
}

const isDenied = (response) =>
  Array.isArray(response.errors) && response.errors.length > 0
    ? response.errors[0].message
    : null;

function loadSeed() {
  try {
    return JSON.parse(readFileSync(resolve(repoRoot, ".foreman-seed.json"), "utf8"));
  } catch {
    throw new Error("No .foreman-seed.json — run `npm run db:seed` first.");
  }
}

/** Org A facts, read with admin rights so the test knows what to aim at. */
async function loadOrgATargets(seed) {
  const data = await adminGraphql(
    `query Targets($orgId: uuid!, $workflowId: uuid!) {
       workflow_runs(where: {org_id: {_eq: $orgId}}, order_by: {created_at: desc}, limit: 1) {
         id
         status
         step_runs(order_by: {position: asc}) { id status step_name }
       }
       workflow_steps(where: {workflow_id: {_eq: $workflowId}}) { id }
     }`,
    { orgId: seed.orgA.id, workflowId: seed.orgA.workflowId },
  );

  const run = data.workflow_runs[0] ?? null;
  const pausedStep = run?.step_runs.find((step) => step.status === "awaiting_approval") ?? null;
  return {
    runId: run?.id ?? null,
    stepRunId: pausedStep?.id ?? run?.step_runs[0]?.id ?? null,
  };
}

async function subscribeOnce(accessToken, role, query, variables, timeoutMs = 12_000) {
  const subdomain = process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN;
  const region = process.env.NEXT_PUBLIC_NHOST_REGION;

  const client = createClient({
    url: `wss://${subdomain}.hasura.${region}.nhost.run/v1/graphql`,
    webSocketImpl: globalThis.WebSocket,
    lazy: true,
    retryAttempts: 0,
    connectionParams: () => ({
      headers: { Authorization: `Bearer ${accessToken}`, "x-hasura-role": role },
    }),
  });

  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      void client.dispose();
      resolvePromise({ timedOut: true });
    }, timeoutMs);

    const finish = (value) => {
      clearTimeout(timer);
      void client.dispose();
      resolvePromise(value);
    };

    client.subscribe(
      { query, variables },
      {
        next: (message) => finish({ data: message.data, errors: message.errors }),
        error: (error) => finish({ socketError: error }),
        complete: () => finish({ completed: true }),
      },
    );
  });
}

async function main() {
  const seed = loadSeed();
  const targets = await loadOrgATargets(seed);
  actionsInSchema = await detectActions();

  console.log(`Org A: ${seed.orgA.name} (${seed.orgA.id})`);
  console.log(`Org B: ${seed.orgB.name} (${seed.orgB.id})`);
  console.log(`Attacking Org A workflow ${seed.orgA.workflowId} as ${seed.users.bOwner.email}\n`);

  const bSession = await signIn(seed.users.bOwner.email, seed.password);
  const bToken = bSession.session.accessToken;

  // --- 1. Direct read by ID, as owner (a role B genuinely holds — in its own org)
  const byPk = await userGraphql(
    bToken,
    `query ($id: uuid!) { workflows_by_pk(id: $id) { id name org_id } }`,
    { id: seed.orgA.workflowId },
    "owner",
  );
  record(
    "Org B cannot read Org A's workflow by ID (role: owner)",
    byPk.data?.workflows_by_pk === null,
    byPk.data?.workflows_by_pk ? "LEAKED the workflow" : isDenied(byPk) || "returned null",
  );

  // --- 2. The same probe under every role B could claim
  for (const role of ["editor", "viewer", "user"]) {
    const response = await userGraphql(
      bToken,
      `query ($id: uuid!) { workflows_by_pk(id: $id) { id } }`,
      { id: seed.orgA.workflowId },
      role,
    );
    const leaked = Boolean(response.data?.workflows_by_pk);
    record(
      `Org B cannot read Org A's workflow by ID (role: ${role})`,
      !leaked,
      leaked ? "LEAKED" : (isDenied(response) ?? "returned null"),
    );
  }

  // --- 3. Listing Org A's rows explicitly
  const listed = await userGraphql(
    bToken,
    `query ($orgId: uuid!) {
       workflows(where: {org_id: {_eq: $orgId}}) { id }
       workflow_runs(where: {org_id: {_eq: $orgId}}) { id }
       org_members(where: {org_id: {_eq: $orgId}}) { id }
     }`,
    { orgId: seed.orgA.id },
    "owner",
  );
  const empties =
    (listed.data?.workflows?.length ?? 1) === 0 &&
    (listed.data?.workflow_runs?.length ?? 1) === 0 &&
    (listed.data?.org_members?.length ?? 1) === 0;
  record("Org B sees no Org A workflows, runs or members when filtering by org_id", empties);

  // --- 4. Step runs of an Org A run
  if (targets.runId) {
    const steps = await userGraphql(
      bToken,
      `query ($runId: uuid!) { step_runs(where: {workflow_run_id: {_eq: $runId}}) { id status } }`,
      { runId: targets.runId },
      "owner",
    );
    record(
      "Org B cannot read Org A's step_runs by run ID",
      (steps.data?.step_runs?.length ?? 1) === 0,
    );

    // --- 5. The live subscription, over a real websocket
    const streamed = await subscribeOnce(
      bToken,
      "owner",
      `subscription ($runId: uuid!) {
         step_runs(where: {workflow_run_id: {_eq: $runId}}, order_by: {position: asc}) { id status }
       }`,
      { runId: targets.runId },
    );
    const rows = streamed.data?.step_runs;
    record(
      "Org B's subscription to an Org A run yields nothing",
      Array.isArray(rows) ? rows.length === 0 : Boolean(streamed.errors || streamed.socketError),
      streamed.timedOut ? "no payload within 12s" : `${rows ? rows.length : "denied"}`,
    );
  } else {
    record("Org A has a run to attack", false, "run the workflow once, then re-run this test");
  }

  // --- 6. Triggering someone else's workflow
  const triggered = await userGraphql(
    bToken,
    `mutation ($id: String!) { triggerWorkflowRun(workflow_id: $id) { run_id status } }`,
    { id: seed.orgA.workflowId },
    "owner",
  );
  record(
    "Org B cannot trigger Org A's workflow",
    !triggered.data?.triggerWorkflowRun,
    isDenied(triggered) ?? "",
    { viaAction: true },
  );

  // --- 7. Approving someone else's paused step
  if (targets.stepRunId) {
    const approved = await userGraphql(
      bToken,
      `mutation ($id: String!) { approveStep(step_run_id: $id) { run_id status } }`,
      { id: targets.stepRunId },
      "owner",
    );
    record(
      "Org B cannot approve an Org A step",
      !approved.data?.approveStep,
      isDenied(approved) ?? "",
      { viaAction: true },
    );
  }

  // --- 8. Writing into Org A
  const inserted = await userGraphql(
    bToken,
    `mutation ($orgId: uuid!) {
       insert_workflows_one(object: {org_id: $orgId, name: "injected by Org B"}) { id }
     }`,
    { orgId: seed.orgA.id },
    "owner",
  );
  record(
    "Org B cannot insert a workflow into Org A",
    !inserted.data?.insert_workflows_one,
    isDenied(inserted) ?? "",
  );

  const saved = await userGraphql(
    bToken,
    `mutation ($workflow: SaveWorkflowInput!) { saveWorkflow(workflow: $workflow) { workflow_id } }`,
    {
      workflow: {
        workflow_id: seed.orgA.workflowId,
        org_id: seed.orgA.id,
        name: "hijacked",
        steps: [],
        triggers: [],
      },
    },
    "owner",
  );
  record(
    "Org B cannot edit Org A's workflow through saveWorkflow",
    !saved.data?.saveWorkflow,
    isDenied(saved) ?? "",
    { viaAction: true },
  );

  // --- 9. Role enforcement inside Org A: a viewer cannot start a run
  const viewerSession = await signIn(seed.users.aViewer.email, seed.password);
  const viewerTrigger = await userGraphql(
    viewerSession.session.accessToken,
    `mutation ($id: String!) { triggerWorkflowRun(workflow_id: $id) { run_id } }`,
    { id: seed.orgA.workflowId },
    "viewer",
  );
  record(
    "An Org A viewer cannot trigger a run in their own org",
    !viewerTrigger.data?.triggerWorkflowRun,
    isDenied(viewerTrigger) ?? "",
    { viaAction: true },
  );

  // A viewer claiming to be an owner still matches no org_members row.
  const viewerAsOwner = await userGraphql(
    viewerSession.session.accessToken,
    `mutation ($id: String!) { triggerWorkflowRun(workflow_id: $id) { run_id } }`,
    { id: seed.orgA.workflowId },
    "owner",
  );
  record(
    "An Org A viewer claiming x-hasura-role: owner is still refused",
    !viewerAsOwner.data?.triggerWorkflowRun,
    isDenied(viewerAsOwner) ?? "",
    { viaAction: true },
  );

  const failed = results.filter((entry) => !entry.passed);
  const skipped = results.filter((entry) => entry.inconclusive);
  console.log(
    `\n${results.length - failed.length - skipped.length}/${results.length} checks passed` +
      (skipped.length ? `, ${skipped.length} inconclusive.` : "."),
  );
  const missing = skipped.filter((entry) => entry.gap === "action-missing");
  const unreachable = skipped.filter((entry) => entry.gap === "handler-unreachable");

  if (missing.length) {
    console.log(
      "\nINCONCLUSIVE — the Actions are not in the GraphQL schema, so these were\n" +
        "refused before any permission check ran. Set ACTION_BASE_URL in the nhost\n" +
        "dashboard, re-run `npm run db:push`, then re-run this test:",
    );
    for (const entry of missing) console.log(`  · ${entry.name}`);
  }
  if (unreachable.length) {
    console.log(
      "\nINCONCLUSIVE — Hasura reached ACTION_BASE_URL but the handler did not\n" +
        "answer, so these failed on the webhook call rather than on a permission\n" +
        "check. Deploy the app (Vercel Framework Preset must be Next.js), then\n" +
        "re-run this test:",
    );
    for (const entry of unreachable) console.log(`  · ${entry.name}`);
  }
  if (failed.length) {
    console.error("\nISOLATION FAILURES:");
    for (const entry of failed) console.error(`  ✗ ${entry.name} — ${entry.detail}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});

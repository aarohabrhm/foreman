/**
 * Runs the acceptance scenario end to end and asserts what happened.
 *
 *   npm run dev            # in another terminal
 *   npm run verify:acceptance
 *
 * The Action handlers are ordinary HTTP endpoints, so this posts exactly the
 * payload Hasura posts (shared secret header + session_variables derived from a
 * verified JWT). That exercises the whole path — Layer 2 checks, the engine,
 * Groq, retries, the pause at the approval gate, resumption, and quota — and
 * observes progress over a real GraphQL subscription rather than by polling.
 *
 * The one link it does not cover is Hasura forwarding the mutation to the
 * handler, which is configuration (ACTION_BASE_URL) rather than code.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "graphql-ws";

import { signIn } from "./lib/auth.mjs";
import { adminGraphql } from "./lib/hasura.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = process.env.FOREMAN_LOCAL_BASE || "http://localhost:3000";
const seed = JSON.parse(readFileSync(resolve(repoRoot, ".foreman-seed.json"), "utf8"));

const checks = [];
const check = (name, passed, detail = "") => {
  checks.push({ name, passed, detail });
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

async function callAction(name, input, sessionVariables) {
  const response = await fetch(`${base}/api/actions/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-foreman-action-secret": process.env.ACTION_SECRET ?? "",
    },
    body: JSON.stringify({
      action: { name },
      input,
      session_variables: sessionVariables,
    }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** Watches step_runs over a websocket, as the browser does. */
function watchRun(accessToken, role, runId, onUpdate) {
  const client = createClient({
    url: `wss://${process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN}.hasura.${process.env.NEXT_PUBLIC_NHOST_REGION}.nhost.run/v1/graphql`,
    webSocketImpl: globalThis.WebSocket,
    lazy: true,
    retryAttempts: 3,
    connectionParams: () => ({
      headers: { Authorization: `Bearer ${accessToken}`, "x-hasura-role": role },
    }),
  });

  const unsubscribe = client.subscribe(
    {
      query: `subscription ($runId: uuid!) {
        step_runs(where: {workflow_run_id: {_eq: $runId}}, order_by: {position: asc}) {
          id position step_name step_type status attempt_count
        }
      }`,
      variables: { runId },
    },
    {
      next: (message) => message.data && onUpdate(message.data.step_runs),
      error: (error) => console.error("  subscription error:", error),
      complete: () => {},
    },
  );

  return () => {
    unsubscribe();
    void client.dispose();
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForRun(runId, predicate, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const data = await adminGraphql(
      `query ($runId: uuid!) {
         workflow_runs_by_pk(id: $runId) {
           id status error
           step_runs(order_by: {position: asc}) {
             id position step_name step_type status attempt_count output error approved_by
           }
         }
       }`,
      { runId },
    );
    const run = data.workflow_runs_by_pk;
    if (run && predicate(run)) return run;
    await sleep(1500);
  }
  throw new Error(`Timed out waiting for run ${runId}`);
}

async function quotaUsed(orgId) {
  const data = await adminGraphql(
    `query ($orgId: uuid!) { organizations_by_pk(id: $orgId) { quota_used quota_allowed } }`,
    { orgId },
  );
  return data.organizations_by_pk;
}

async function main() {
  console.log(`Driving handlers at ${base}\n`);

  const health = await fetch(base).catch(() => null);
  if (!health) throw new Error(`Nothing is listening on ${base} — run \`npm run dev\` first.`);

  const owner = (await signIn(seed.users.aOwner.email, seed.password)).session;
  const editor = (await signIn(seed.users.aEditor.email, seed.password)).session;

  const ownerVars = { "x-hasura-user-id": owner.user.id, "x-hasura-role": "owner" };
  const editorVars = { "x-hasura-user-id": editor.user.id, "x-hasura-role": "editor" };
  const viewerId = seed.users.aViewer.id;

  const quotaBefore = await quotaUsed(seed.orgA.id);

  // --- 1. A viewer cannot start a run (Layer 2) ----------------------------
  const viewerAttempt = await callAction(
    "triggerWorkflowRun",
    { workflow_id: seed.orgA.workflowId },
    { "x-hasura-user-id": viewerId, "x-hasura-role": "viewer" },
  );
  check(
    "viewer cannot trigger a run",
    viewerAttempt.status === 403,
    viewerAttempt.body?.message ?? `status ${viewerAttempt.status}`,
  );

  // --- 2. Org B's owner cannot start an Org A run --------------------------
  const crossOrg = await callAction(
    "triggerWorkflowRun",
    { workflow_id: seed.orgA.workflowId },
    { "x-hasura-user-id": seed.users.bOwner.id, "x-hasura-role": "owner" },
  );
  check(
    "Org B owner cannot trigger Org A's workflow",
    crossOrg.status === 403 && /not found/i.test(crossOrg.body?.message ?? ""),
    crossOrg.body?.message ?? `status ${crossOrg.status}`,
  );

  // --- 3. The owner starts a run ------------------------------------------
  const started = await callAction(
    "triggerWorkflowRun",
    {
      workflow_id: seed.orgA.workflowId,
      input_json: JSON.stringify({ text: "The checkout API is down for all customers." }),
    },
    ownerVars,
  );
  check("owner can trigger a run", started.status === 200, started.body?.message ?? "");
  if (started.status !== 200) throw new Error("cannot continue without a run");

  const runId = started.body.run_id;
  console.log(`\n  run ${runId}`);

  // --- 4. Live progress over a subscription --------------------------------
  const seenLive = new Map();
  const stop = watchRun(owner.accessToken, "owner", runId, (rows) => {
    for (const row of rows) {
      const previous = seenLive.get(row.id);
      if (previous !== row.status) {
        seenLive.set(row.id, row.status);
        console.log(`    live: ${row.position}. ${row.step_name} -> ${row.status}`);
      }
    }
  });

  const paused = await waitForRun(runId, (run) => run.status === "paused" || run.status === "failed");
  check("run reaches the approval gate and pauses", paused.status === "paused", paused.error ?? "");

  const gate = paused.step_runs.find((step) => step.step_type === "approval_gate");
  check(
    "the gate step is awaiting_approval",
    gate?.status === "awaiting_approval",
    gate?.status ?? "no gate step",
  );

  const llm = paused.step_runs.find((step) => step.step_type === "llm_call");
  const stubbed = llm?.output?.stubbed === true;
  check(
    "llm_call produced a real completion",
    llm?.status === "succeeded" && !stubbed,
    stubbed ? "STUBBED (GROQ_API_KEY missing)" : `"${String(llm?.output?.text ?? "").trim().slice(0, 60)}"`,
  );

  const branch = paused.step_runs.find((step) => step.step_type === "conditional_branch");
  const httpSteps = paused.step_runs.filter((step) => step.step_type === "http_request");
  const ran = httpSteps.filter((step) => step.status === "succeeded");
  const skipped = httpSteps.filter((step) => step.status === "skipped");
  check(
    "conditional_branch ran exactly one side",
    ran.length === 1 && skipped.length === 1,
    `branch=${branch?.output?.result} ran="${ran[0]?.step_name}" skipped="${skipped[0]?.step_name}"`,
  );

  check(
    "live subscription observed the steps without polling",
    seenLive.size >= 3,
    `${seenLive.size} step transitions seen on the socket`,
  );

  // --- 5. Approval by an editor resumes the run ----------------------------
  const wrongApprover = await callAction(
    "approveStep",
    { step_run_id: gate.id },
    { "x-hasura-user-id": seed.users.bOwner.id, "x-hasura-role": "owner" },
  );
  check(
    "Org B owner cannot approve Org A's gate",
    wrongApprover.status === 403,
    wrongApprover.body?.message ?? `status ${wrongApprover.status}`,
  );

  const viewerApprove = await callAction(
    "approveStep",
    { step_run_id: gate.id },
    { "x-hasura-user-id": viewerId, "x-hasura-role": "viewer" },
  );
  check(
    "an Org A viewer cannot approve the gate",
    viewerApprove.status === 403,
    viewerApprove.body?.message ?? `status ${viewerApprove.status}`,
  );

  const approved = await callAction("approveStep", { step_run_id: gate.id, note: "looks right" }, editorVars);
  check("an Org A editor can approve the gate", approved.status === 200, approved.body?.message ?? "");

  const finished = await waitForRun(
    runId,
    (run) => run.status === "succeeded" || run.status === "failed",
  );
  check("the run resumes and completes", finished.status === "succeeded", finished.error ?? "");

  const gateAfter = finished.step_runs.find((step) => step.step_type === "approval_gate");
  check(
    "the gate records who approved it",
    gateAfter?.approved_by === editor.user.id,
    gateAfter?.approved_by ?? "not recorded",
  );

  const dbWrite = finished.step_runs.find((step) => step.step_type === "db_write");
  check(
    "the db_write step ran after approval",
    dbWrite?.status === "succeeded",
    dbWrite?.status ?? "missing",
  );

  const quotaAfter = await quotaUsed(seed.orgA.id);
  check(
    "quota is consumed once for the run",
    quotaAfter.quota_used === quotaBefore.quota_used + 1,
    `${quotaBefore.quota_used} -> ${quotaAfter.quota_used} of ${quotaAfter.quota_allowed}`,
  );

  stop();

  const failed = checks.filter((entry) => !entry.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length) {
    console.error("\nFAILURES:");
    for (const entry of failed) console.error(`  ✗ ${entry.name} — ${entry.detail}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});

/**
 * End-to-end verification through the real path:
 *
 *   browser -> Hasura GraphQL -> Action -> deployed handler -> engine -> Postgres
 *                                                                   -> subscription
 *
 *   npm run test:deployed
 *
 * Every other suite drives the handlers directly. This one touches nothing but
 * the public GraphQL endpoint and the database, so it exercises the one link
 * the others cannot: Hasura actually calling the deployed app.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { signIn, userGraphql } from "../../scripts/lib/auth.mjs";
import { adminGraphql } from "../../scripts/lib/hasura.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const seed = JSON.parse(readFileSync(resolve(repoRoot, ".foreman-seed.json"), "utf8"));

const checks = [];
const check = (name, passed, detail = "") => {
  checks.push({ name, passed, detail });
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const firstError = (response) => response.errors?.[0]?.message ?? "";

async function waitForRun(runId, predicate, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const data = await adminGraphql(
      `query ($runId: uuid!) {
         workflow_runs_by_pk(id: $runId) {
           id status error trigger_type
           step_runs(order_by: {position: asc}) {
             id position step_name step_type status approved_by
           }
         }
       }`,
      { runId },
    );
    last = data.workflow_runs_by_pk;
    if (last && predicate(last)) return last;
    await sleep(2000);
  }
  return last;
}

async function main() {
  console.log("Everything below goes through Hasura, not the handlers directly.\n");

  const owner = (await signIn(seed.users.aOwner.email, seed.password)).session;
  const editor = (await signIn(seed.users.aEditor.email, seed.password)).session;

  // --- 1. Trigger a run through the Hasura Action ---------------------------
  const triggered = await userGraphql(
    owner.accessToken,
    `mutation ($id: String!, $input: String) {
       triggerWorkflowRun(workflow_id: $id, input_json: $input) { run_id status }
     }`,
    {
      id: seed.orgA.workflowId,
      input: JSON.stringify({ text: "The checkout API is down for all customers." }),
    },
    "owner",
  );
  const runId = triggered.data?.triggerWorkflowRun?.run_id;
  check(
    "Hasura routes triggerWorkflowRun to the deployed handler",
    Boolean(runId),
    runId ?? firstError(triggered),
  );
  if (!runId) throw new Error("cannot continue without a run");

  // --- 2. The engine runs on Vercel and pauses at the gate ------------------
  const paused = await waitForRun(runId, (run) => run.status === "paused" || run.status === "failed");
  check(
    "the deployed engine executes the steps and pauses at the gate",
    paused?.status === "paused",
    `status=${paused?.status}${paused?.error ? ` (${paused.error})` : ""}`,
  );

  const gate = paused?.step_runs.find((step) => step.step_type === "approval_gate");
  const ranSteps = paused?.step_runs.filter((s) => s.status === "succeeded").length ?? 0;
  const skippedSteps = paused?.step_runs.filter((s) => s.status === "skipped").length ?? 0;
  check(
    "the branch was evaluated on the server",
    ranSteps >= 3 && skippedSteps === 1,
    `${ranSteps} succeeded, ${skippedSteps} skipped`,
  );

  // --- 3. Approval is refused for the wrong people, through Hasura ----------
  const viewer = (await signIn(seed.users.aViewer.email, seed.password)).session;
  const viewerApprove = await userGraphql(
    viewer.accessToken,
    `mutation ($id: String!) { approveStep(step_run_id: $id) { run_id status } }`,
    { id: gate.id },
    "viewer",
  );
  check(
    "a viewer cannot approve, through the real Action",
    !viewerApprove.data?.approveStep,
    firstError(viewerApprove),
  );

  const bOwner = (await signIn(seed.users.bOwner.email, seed.password)).session;
  const crossApprove = await userGraphql(
    bOwner.accessToken,
    `mutation ($id: String!) { approveStep(step_run_id: $id) { run_id status } }`,
    { id: gate.id },
    "owner",
  );
  check(
    "an Org B owner cannot approve an Org A gate, through the real Action",
    !crossApprove.data?.approveStep,
    firstError(crossApprove),
  );

  const crossTrigger = await userGraphql(
    bOwner.accessToken,
    `mutation ($id: String!) { triggerWorkflowRun(workflow_id: $id) { run_id } }`,
    { id: seed.orgA.workflowId },
    "owner",
  );
  check(
    "an Org B owner cannot trigger an Org A workflow, through the real Action",
    !crossTrigger.data?.triggerWorkflowRun,
    firstError(crossTrigger),
  );

  // --- 4. The editor approves and the run resumes on Vercel ----------------
  const approved = await userGraphql(
    editor.accessToken,
    `mutation ($id: String!, $note: String) {
       approveStep(step_run_id: $id, note: $note) { run_id status }
     }`,
    { id: gate.id, note: "approved via the live app" },
    "editor",
  );
  check("an editor can approve, through the real Action", Boolean(approved.data?.approveStep), firstError(approved));

  const finished = await waitForRun(runId, (run) => ["succeeded", "failed"].includes(run.status));
  check(
    "the run resumes on the deployed app and completes",
    finished?.status === "succeeded",
    `status=${finished?.status}${finished?.error ? ` (${finished.error})` : ""}`,
  );

  // --- 5. The webhook Action, unauthenticated, through Hasura ---------------
  const webhook = await fetch(
    `https://${process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN}.hasura.${process.env.NEXT_PUBLIC_NHOST_REGION}.nhost.run/v1/graphql`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `mutation ($id: String!, $token: String!, $payload: String) {
          startWorkflowViaWebhook(workflow_id: $id, token: $token, payload_json: $payload) {
            run_id status
          }
        }`,
        variables: {
          id: seed.orgA.workflowId,
          token: seed.webhookToken,
          payload: JSON.stringify({ text: "Payments are failing for every customer." }),
        },
      }),
    },
  ).then((r) => r.json());
  const webhookRunId = webhook.data?.startWorkflowViaWebhook?.run_id;
  check(
    "an unauthenticated webhook call starts a run",
    Boolean(webhookRunId),
    webhookRunId ?? firstError(webhook),
  );

  // --- 6. The database-event trigger, fired by Hasura ------------------------
  const runsBefore = (
    await adminGraphql(
      `query ($workflowId: uuid!) {
         workflow_runs(where: {workflow_id: {_eq: $workflowId}, trigger_type: {_eq: "database_event"}}) { id }
       }`,
      { workflowId: seed.orgA.workflowId },
    )
  ).workflow_runs.length;

  const inserted = await userGraphql(
    owner.accessToken,
    `mutation ($orgId: uuid!, $payload: jsonb!) {
       insert_watched_records_one(object: {org_id: $orgId, label: "support-ticket", payload: $payload}) { id }
     }`,
    { orgId: seed.orgA.id, payload: { text: "The dashboard is blank for everyone." } },
    "owner",
  );
  check(
    "inserting a watched_records row succeeds",
    Boolean(inserted.data?.insert_watched_records_one),
    firstError(inserted),
  );

  let runsAfter = runsBefore;
  for (let attempt = 0; attempt < 15 && runsAfter === runsBefore; attempt += 1) {
    await sleep(2000);
    runsAfter = (
      await adminGraphql(
        `query ($workflowId: uuid!) {
           workflow_runs(where: {workflow_id: {_eq: $workflowId}, trigger_type: {_eq: "database_event"}}) { id }
         }`,
        { workflowId: seed.orgA.workflowId },
      )
    ).workflow_runs.length;
  }
  check(
    "Hasura's Event Trigger starts a run with no button click",
    runsAfter === runsBefore + 1,
    `${runsBefore} -> ${runsAfter} database_event runs`,
  );

  // --- 7. notify delivered by the Event Trigger -----------------------------
  let notification = null;
  for (let attempt = 0; attempt < 10 && !notification?.delivered_at; attempt += 1) {
    await sleep(2000);
    notification = (
      await adminGraphql(
        `query ($runId: uuid!) {
           notifications(where: {workflow_run_id: {_eq: $runId}}, limit: 1) {
             id status delivered_at error
           }
         }`,
        { runId },
      )
    ).notifications[0];
  }
  check(
    "the notify step's message is delivered by the Event Trigger",
    Boolean(notification?.delivered_at),
    notification ? `status=${notification.status}` : "no notification row",
  );

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

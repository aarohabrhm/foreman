/**
 * Verifies the three non-manual triggers and the notify delivery hook.
 *
 *   npm run dev            # in another terminal
 *   npm run test:triggers
 *
 * Like run-lifecycle, this posts the exact payloads Hasura posts — the
 * webhook Action's input, an Event Trigger's `event.data.new` envelope, and the
 * cron trigger's tick — so the handler logic is proven independently of whether
 * ACTION_BASE_URL has been configured yet. What it does NOT prove is Hasura
 * calling these URLs; that is configuration, and it is the last thing to check
 * once the app is deployed.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { adminGraphql } from "../../scripts/lib/hasura.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const base = process.env.FOREMAN_LOCAL_BASE || "http://localhost:3000";
const seed = JSON.parse(readFileSync(resolve(repoRoot, ".foreman-seed.json"), "utf8"));

const checks = [];
const check = (name, passed, detail = "") => {
  checks.push({ name, passed, detail });
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(path, body, { secret = process.env.ACTION_SECRET } = {}) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { "x-foreman-action-secret": secret } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function runsFor(workflowId, triggerType) {
  const data = await adminGraphql(
    `query ($workflowId: uuid!, $triggerType: String!) {
       workflow_runs(
         where: {workflow_id: {_eq: $workflowId}, trigger_type: {_eq: $triggerType}},
         order_by: {created_at: desc}
       ) { id status created_at }
     }`,
    { workflowId, triggerType },
  );
  return data.workflow_runs;
}

async function main() {
  console.log(`Driving handlers at ${base}\n`);
  if (!(await fetch(base).catch(() => null))) {
    throw new Error(`Nothing is listening on ${base} — run \`npm run dev\` first.`);
  }

  // --- The shared secret is what makes these public URLs safe ---------------
  const noSecret = await post("/api/hooks/notify", {}, { secret: null });
  check("a hook without the shared secret is rejected", noSecret.status === 401, noSecret.body?.message ?? "");

  const wrongSecret = await post("/api/hooks/notify", {}, { secret: "not-the-secret" });
  check("a hook with the wrong shared secret is rejected", wrongSecret.status === 401, "");

  // --- Webhook trigger ------------------------------------------------------
  const before = (await runsFor(seed.orgA.workflowId, "webhook")).length;

  const badToken = await post("/api/actions/startWorkflowViaWebhook", {
    action: { name: "startWorkflowViaWebhook" },
    input: { workflow_id: seed.orgA.workflowId, token: "fwh_not-a-real-token" },
    session_variables: { "x-hasura-role": "public" },
  });
  check(
    "webhook with a wrong token is refused",
    badToken.status === 403,
    badToken.body?.message ?? `status ${badToken.status}`,
  );

  if (!seed.webhookToken) {
    check("webhook token available to test with", false, "re-run db:seed to mint one");
  } else {
    const started = await post("/api/actions/startWorkflowViaWebhook", {
      action: { name: "startWorkflowViaWebhook" },
      input: {
        workflow_id: seed.orgA.workflowId,
        token: seed.webhookToken,
        payload_json: JSON.stringify({ text: "Payments are failing for every customer." }),
      },
      session_variables: { "x-hasura-role": "public" },
    });
    check(
      "webhook with the correct token starts a run",
      started.status === 200 && Boolean(started.body?.run_id),
      started.body?.run_id ?? started.body?.message ?? "",
    );

    if (started.body?.run_id) {
      await sleep(12_000);
      const data = await adminGraphql(
        `query ($runId: uuid!) {
           workflow_runs_by_pk(id: $runId) {
             status trigger_type
             step_runs(order_by: {position: asc}) { step_name step_type status }
           }
         }`,
        { runId: started.body.run_id },
      );
      const run = data.workflow_runs_by_pk;
      check(
        "the webhook-triggered run executes and pauses at the gate",
        run?.status === "paused" && run.trigger_type === "webhook",
        `status=${run?.status}, ${run?.step_runs.length ?? 0} steps ran`,
      );
    }
  }

  const after = (await runsFor(seed.orgA.workflowId, "webhook")).length;
  check("exactly one webhook run was created", after === before + 1, `${before} -> ${after}`);

  // --- Database-event trigger ----------------------------------------------
  const record = await adminGraphql(
    `mutation ($object: watched_records_insert_input!) {
       insert_watched_records_one(object: $object) { id org_id label payload }
     }`,
    {
      object: {
        org_id: seed.orgA.id,
        label: "support-ticket",
        payload: { text: "A customer reports the dashboard is blank." },
      },
    },
  );

  const dbEvent = await post("/api/hooks/db-event", {
    event: { op: "INSERT", data: { new: record.insert_watched_records_one } },
    table: { schema: "public", name: "watched_records" },
    trigger: { name: "watched_records_start_runs" },
  });
  check(
    "a watched_records insert starts a run with no button click",
    dbEvent.status === 200 && (dbEvent.body?.started_runs?.length ?? 0) === 1,
    JSON.stringify(dbEvent.body?.started_runs ?? dbEvent.body),
  );

  // A row whose label no trigger is watching must start nothing.
  const otherRecord = await adminGraphql(
    `mutation ($object: watched_records_insert_input!) {
       insert_watched_records_one(object: $object) { id org_id label payload }
     }`,
    { object: { org_id: seed.orgA.id, label: "unrelated-label", payload: {} } },
  );
  const ignored = await post("/api/hooks/db-event", {
    event: { op: "INSERT", data: { new: otherRecord.insert_watched_records_one } },
  });
  check(
    "a row with a non-matching label starts nothing",
    (ignored.body?.started_runs?.length ?? 1) === 0,
    JSON.stringify(ignored.body?.started_runs ?? []),
  );

  // An Org B row must never start an Org A workflow.
  const orgBRecord = await adminGraphql(
    `mutation ($object: watched_records_insert_input!) {
       insert_watched_records_one(object: $object) { id org_id label payload }
     }`,
    { object: { org_id: seed.orgB.id, label: "support-ticket", payload: {} } },
  );
  const orgBEvent = await post("/api/hooks/db-event", {
    event: { op: "INSERT", data: { new: orgBRecord.insert_watched_records_one } },
  });
  const startedIds = orgBEvent.body?.started_runs ?? [];
  let leaked = false;
  for (const runId of startedIds) {
    const data = await adminGraphql(
      `query ($runId: uuid!) { workflow_runs_by_pk(id: $runId) { org_id } }`,
      { runId },
    );
    if (data.workflow_runs_by_pk?.org_id !== seed.orgB.id) leaked = true;
  }
  check(
    "an Org B row never starts an Org A workflow",
    !leaked,
    `${startedIds.length} run(s), all in Org B`,
  );

  // --- Scheduled trigger ----------------------------------------------------
  // Org B's workflow carries a scheduled trigger with a 1440-minute cadence, so
  // the first tick is due and the second is not.
  await adminGraphql(
    `mutation ($workflowId: uuid!) {
       delete_workflow_runs(where: {workflow_id: {_eq: $workflowId}, trigger_type: {_eq: "scheduled"}}) {
         affected_rows
       }
     }`,
    { workflowId: seed.orgB.workflowId },
  );

  const tick = () =>
    post("/api/hooks/scheduled", {
      scheduled_time: new Date().toISOString(),
      payload: {},
      name: "foreman_scheduled_dispatch",
    });

  const firstTick = await tick();
  check(
    "a cron tick starts a due scheduled workflow",
    firstTick.status === 200 && (firstTick.body?.started_runs?.length ?? 0) === 1,
    JSON.stringify(firstTick.body?.started_runs ?? firstTick.body),
  );

  const secondTick = await tick();
  check(
    "the next tick respects the configured cadence and starts nothing",
    (secondTick.body?.started_runs?.length ?? 1) === 0,
    `every_minutes=1440, so it is not due again`,
  );

  // --- notify delivery ------------------------------------------------------
  const notification = await adminGraphql(
    `mutation ($object: notifications_insert_input!) {
       insert_notifications_one(object: $object) { id status }
     }`,
    {
      object: {
        org_id: seed.orgA.id,
        channel: "slack",
        message: "Foreman verification message",
      },
    },
  );

  const delivered = await post("/api/hooks/notify", {
    event: { op: "INSERT", data: { new: { ...notification.insert_notifications_one, message: "Foreman verification message", channel: "slack" } } },
    table: { schema: "public", name: "notifications" },
  });
  check("the notify hook accepts the event", delivered.status === 200, JSON.stringify(delivered.body));

  const stamped = await adminGraphql(
    `query ($id: uuid!) { notifications_by_pk(id: $id) { status delivered_at error } }`,
    { id: notification.insert_notifications_one.id },
  );
  check(
    "the notification is stamped as stubbed (SLACK_WEBHOOK_URL unset) and disclosed",
    stamped.notifications_by_pk?.status === "stubbed" &&
      Boolean(stamped.notifications_by_pk?.delivered_at),
    `status=${stamped.notifications_by_pk?.status}`,
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

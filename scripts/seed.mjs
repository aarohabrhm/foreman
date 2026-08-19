/**
 * Seeds the two organizations, four users and the demo workflow the acceptance
 * scenario runs on.  Run with:  npm run db:seed
 *
 * Safe to re-run: users are reused if they already exist, and the orgs and
 * workflow are matched by name.
 */

import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureUser } from "./lib/auth.mjs";
import { adminGraphql, hasuraBaseUrl, runSql } from "./lib/hasura.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const password = process.env.SEED_PASSWORD || "Foreman!2026";

// nhost validates displayName against ^[\p{L}\p{N}\p{S} ,.'-]+$ — no parentheses.
const USERS = [
  { key: "aOwner", email: "a-owner@foreman.test", name: "Ada - Org A owner" },
  { key: "aEditor", email: "a-editor@foreman.test", name: "Eli - Org A editor" },
  { key: "aViewer", email: "a-viewer@foreman.test", name: "Vic - Org A viewer" },
  { key: "bOwner", email: "b-owner@foreman.test", name: "Bo - Org B owner" },
];

/**
 * Lets a user *present* any of the three roles.
 *
 * nhost models allowed roles per user and globally (auth.user_roles); this app
 * models them per organization (public.org_members). Granting all three to every
 * seeded account keeps those two facts from being confused — and makes the point
 * the permission design rests on directly testable: holding `owner` in the JWT
 * buys nothing, because every rule still has to find a matching org_members row.
 * scripts/test-cross-org.mjs relies on exactly this to attack Org A as `owner`.
 */
async function grantSelectableRoles(userId) {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error(`Unexpected user id: ${userId}`);
  await runSql(`
    INSERT INTO auth.user_roles (user_id, role)
    SELECT '${userId}'::uuid, r.role
    FROM (VALUES ('user'), ('owner'), ('editor'), ('viewer')) AS r(role)
    WHERE NOT EXISTS (
      SELECT 1 FROM auth.user_roles existing
      WHERE existing.user_id = '${userId}'::uuid AND existing.role = r.role
    );
  `);
}

async function upsertOrg(name, quotaAllowed) {
  const existing = await adminGraphql(
    `query OrgByName($name: String!) {
       organizations(where: {name: {_eq: $name}}, limit: 1) { id name }
     }`,
    { name },
  );
  if (existing.organizations[0]) return existing.organizations[0].id;

  const created = await adminGraphql(
    `mutation CreateOrg($object: organizations_insert_input!) {
       insert_organizations_one(object: $object) { id }
     }`,
    { object: { name, quota_allowed: quotaAllowed } },
  );
  return created.insert_organizations_one.id;
}

async function upsertMember(orgId, userId, role, email) {
  await adminGraphql(
    `mutation AddMember($object: org_members_insert_input!) {
       insert_org_members_one(
         object: $object,
         on_conflict: {constraint: org_members_org_id_user_id_key, update_columns: [role, invited_email]}
       ) { id }
     }`,
    { object: { org_id: orgId, user_id: userId, role, invited_email: email } },
  );
}

/**
 * The acceptance-scenario workflow, as a graph:
 *
 *                        /-- true --> page-on-call
 *   classify --> is-urgent
 *                        \- false --> log-routine
 *                              |
 *                              +--> human-approval --> record-outcome --> announce
 *
 * Note where the approval gate hangs: off the CONDITIONAL, not off either arm.
 * That is what makes it run whichever way the branch went. Hanging it off both
 * arms would work too — a step is reached when ANY incoming connection is live
 * — but connecting it to the conditional says "always, after the decision",
 * which is what is actually meant.
 */
function demoSteps() {
  return [
    {
      slug: "classify",
      position: 0,
      name: "Classify the request",
      type: "llm_call",
      ui_x: 0,
      ui_y: 0,
      config: {
        system:
          "You triage inbound support requests. Reply with exactly one word: URGENT or ROUTINE.",
        prompt: "Classify this request: {{trigger.text}}",
        temperature: 0,
        max_tokens: 16,
      },
    },
    {
      slug: "is-urgent",
      position: 1,
      name: "Is it urgent?",
      type: "conditional_branch",
      ui_x: 260,
      ui_y: 0,
      config: { left: "{{last.text}}", operator: "contains", right: "URGENT" },
    },
    {
      slug: "page-on-call",
      position: 2,
      name: "Page the on-call service",
      type: "http_request",
      ui_x: 520,
      ui_y: -130,
      config: {
        method: "POST",
        url: "https://postman-echo.com/post",
        // Addressed by slug rather than position: positions are derived from
        // the graph now, so they move when the workflow is rewired.
        body: { severity: "high", summary: "{{steps.classify.output.text}}" },
      },
    },
    {
      slug: "log-routine",
      position: 3,
      name: "Log to the routine queue",
      type: "http_request",
      ui_x: 520,
      ui_y: 130,
      config: {
        method: "POST",
        url: "https://postman-echo.com/post",
        body: { severity: "normal", summary: "{{steps.classify.output.text}}" },
      },
    },
    {
      slug: "human-approval",
      position: 4,
      name: "Human approval",
      type: "approval_gate",
      ui_x: 780,
      ui_y: 0,
      config: {
        instructions: "Confirm the triage decision before it is recorded.",
        approver_roles: ["owner", "editor"],
      },
    },
    {
      slug: "record-outcome",
      position: 5,
      name: "Record the outcome",
      type: "db_write",
      ui_x: 1040,
      ui_y: 0,
      config: {
        label: "triage-outcome",
        payload: {
          classification: "{{steps.classify.output.text}}",
          urgent: "{{steps.is-urgent.output.result}}",
        },
      },
    },
    {
      slug: "announce",
      position: 6,
      name: "Announce the outcome",
      type: "notify",
      ui_x: 1300,
      ui_y: 0,
      config: {
        channel: "slack",
        message: "Triage complete: {{steps.classify.output.text}}",
      },
    },
  ];
}

function demoEdges() {
  return [
    { from_slug: "classify", to_slug: "is-urgent", branch_key: "" },
    { from_slug: "is-urgent", to_slug: "page-on-call", branch_key: "true" },
    { from_slug: "is-urgent", to_slug: "log-routine", branch_key: "false" },
    { from_slug: "is-urgent", to_slug: "human-approval", branch_key: "" },
    { from_slug: "human-approval", to_slug: "record-outcome", branch_key: "" },
    { from_slug: "record-outcome", to_slug: "announce", branch_key: "" },
  ];
}

async function upsertWorkflow(orgId, name, createdBy) {
  const existing = await adminGraphql(
    `query WorkflowByName($orgId: uuid!, $name: String!) {
       workflows(where: {org_id: {_eq: $orgId}, name: {_eq: $name}}, limit: 1) { id }
     }`,
    { orgId, name },
  );

  const workflowId =
    existing.workflows[0]?.id ??
    (
      await adminGraphql(
        `mutation CreateWorkflow($object: workflows_insert_input!) {
           insert_workflows_one(object: $object) { id }
         }`,
        {
          object: {
            org_id: orgId,
            name,
            description: "Triage an inbound support request, then wait for a human to sign off.",
            created_by: createdBy,
          },
        },
      )
    ).insert_workflows_one.id;

  const steps = demoSteps();
  const edges = demoEdges();

  // Same order as the saveWorkflow Action, and for the same reasons: the
  // connections go first so a step can be deleted without tripping the foreign
  // keys pointing at its slug, and the removals go before the upsert because
  // (workflow_id, position) is only deferred within a single mutation.
  await adminGraphql(
    `mutation ClearEdges($workflowId: uuid!) {
       delete_workflow_step_edges(where: {workflow_id: {_eq: $workflowId}}) { affected_rows }
     }`,
    { workflowId },
  );
  await adminGraphql(
    `mutation DropRemovedSteps($workflowId: uuid!, $keep: [String!]!) {
       delete_workflow_steps(where: {workflow_id: {_eq: $workflowId}, slug: {_nin: $keep}}) {
         affected_rows
       }
     }`,
    { workflowId, keep: steps.map((step) => step.slug) },
  );
  // Upserts on slug, not position: position is derived from the graph and moves
  // when the workflow is rewired, and its unique constraint is deferrable — so
  // Postgres would refuse it as an ON CONFLICT arbiter.
  await adminGraphql(
    `mutation UpsertSteps($objects: [workflow_steps_insert_input!]!) {
       insert_workflow_steps(
         objects: $objects,
         on_conflict: {
           constraint: workflow_steps_workflow_id_slug_key,
           update_columns: [name, type, config, position, ui_x, ui_y]
         }
       ) { affected_rows }
     }`,
    { objects: steps.map((step) => ({ ...step, workflow_id: workflowId })) },
  );
  await adminGraphql(
    `mutation InsertEdges($objects: [workflow_step_edges_insert_input!]!) {
       insert_workflow_step_edges(
         objects: $objects,
         on_conflict: {constraint: workflow_step_edges_unique_edge, update_columns: []}
       ) { affected_rows }
     }`,
    { objects: edges.map((edge) => ({ ...edge, workflow_id: workflowId })) },
  );

  return workflowId;
}

async function upsertTriggers(workflowId) {
  const existing = await adminGraphql(
    `query Triggers($workflowId: uuid!) {
       workflow_triggers(where: {workflow_id: {_eq: $workflowId}}) { trigger_type token_hash }
     }`,
    { workflowId },
  );

  const webhook = existing.workflow_triggers.find((row) => row.trigger_type === "webhook");
  let token = null;
  let tokenHash = webhook?.token_hash ?? null;

  if (!tokenHash) {
    token = `fwh_${randomBytes(24).toString("base64url")}`;
    tokenHash = createHash("sha256").update(token).digest("hex");
  }

  await adminGraphql(
    `mutation UpsertTriggers($objects: [workflow_triggers_insert_input!]!) {
       insert_workflow_triggers(
         objects: $objects,
         on_conflict: {
           constraint: workflow_triggers_workflow_id_trigger_type_key,
           update_columns: [config, is_enabled, token_hash]
         }
       ) { affected_rows }
     }`,
    {
      objects: [
        { workflow_id: workflowId, trigger_type: "manual", config: {}, is_enabled: true },
        {
          workflow_id: workflowId,
          trigger_type: "webhook",
          config: {},
          is_enabled: true,
          token_hash: tokenHash,
        },
        {
          workflow_id: workflowId,
          trigger_type: "database_event",
          config: { label: "support-ticket" },
          is_enabled: true,
        },
      ],
    },
  );

  return token;
}

async function main() {
  console.log(`Target: ${hasuraBaseUrl()}\n`);

  const users = {};
  for (const spec of USERS) {
    const { session, created } = await ensureUser(spec.email, password, spec.name);
    users[spec.key] = { id: session.user.id, email: spec.email };
    await grantSelectableRoles(session.user.id);
    console.log(`  ${created ? "created" : "reusing"} ${spec.email}`);
  }

  const orgA = await upsertOrg("Northwind Support", 25);
  const orgB = await upsertOrg("Contoso Logistics", 25);
  console.log(`\n  Org A (Northwind Support): ${orgA}`);
  console.log(`  Org B (Contoso Logistics): ${orgB}`);

  await upsertMember(orgA, users.aOwner.id, "owner", users.aOwner.email);
  await upsertMember(orgA, users.aEditor.id, "editor", users.aEditor.email);
  await upsertMember(orgA, users.aViewer.id, "viewer", users.aViewer.email);
  await upsertMember(orgB, users.bOwner.id, "owner", users.bOwner.email);

  const workflowA = await upsertWorkflow(orgA, "Support triage", users.aOwner.id);
  const token = await upsertTriggers(workflowA);
  const workflowB = await upsertWorkflow(orgB, "Contoso internal triage", users.bOwner.id);

  // Org B carries the scheduled trigger, so the cron path is demonstrable
  // without adding recurring runs to the org used for the walkthrough.
  await adminGraphql(
    `mutation UpsertScheduled($object: workflow_triggers_insert_input!) {
       insert_workflow_triggers_one(
         object: $object,
         on_conflict: {
           constraint: workflow_triggers_workflow_id_trigger_type_key,
           update_columns: [config, is_enabled]
         }
       ) { id }
     }`,
    {
      object: {
        workflow_id: workflowB,
        trigger_type: "scheduled",
        config: { every_minutes: 1440 },
        is_enabled: true,
      },
    },
  );

  // Only a hash of the webhook token is stored, so a token minted by an earlier
  // run can never be recovered — re-running the seed must not overwrite the
  // recorded one with null.
  const seedPath = resolve(repoRoot, ".foreman-seed.json");
  let previousToken = null;
  try {
    previousToken = JSON.parse(readFileSync(seedPath, "utf8")).webhookToken ?? null;
  } catch {
    /* first run */
  }

  const seed = {
    password,
    orgA: { id: orgA, name: "Northwind Support", workflowId: workflowA },
    orgB: { id: orgB, name: "Contoso Logistics", workflowId: workflowB },
    users,
    webhookToken: token ?? previousToken,
  };
  writeFileSync(seedPath, JSON.stringify(seed, null, 2));

  console.log(`\n  Org A workflow: ${workflowA}`);
  console.log(`  Org B workflow: ${workflowB}`);
  console.log(`\nAccounts (password: ${password}):`);
  for (const spec of USERS) console.log(`  ${spec.email.padEnd(24)} ${spec.name}`);

  if (token) {
    console.log(`\nWebhook token (shown once, only its hash is stored):\n  ${token}`);
  } else {
    console.log(
      "\nWebhook token already existed and cannot be re-read (only its hash is stored).\n" +
        "  Delete the webhook trigger row and re-run the seed to mint a new one.",
    );
  }

  console.log("\nWrote .foreman-seed.json (gitignored) — used by npm run test:cross-org.");
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});

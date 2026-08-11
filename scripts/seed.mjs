/**
 * Seeds the two organizations, four users and the demo workflow the acceptance
 * scenario runs on.  Run with:  npm run db:seed
 *
 * Safe to re-run: users are reused if they already exist, and the orgs and
 * workflow are matched by name.
 */

import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureUser } from "./lib/auth.mjs";
import { adminGraphql, hasuraBaseUrl } from "./lib/hasura.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const password = process.env.SEED_PASSWORD || "Foreman!2026";

const USERS = [
  { key: "aOwner", email: "a-owner@foreman.test", name: "Ada (Org A owner)" },
  { key: "aEditor", email: "a-editor@foreman.test", name: "Eli (Org A editor)" },
  { key: "aViewer", email: "a-viewer@foreman.test", name: "Vic (Org A viewer)" },
  { key: "bOwner", email: "b-owner@foreman.test", name: "Bo (Org B owner)" },
];

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
 * The acceptance-scenario workflow:
 *   llm_call -> conditional_branch -> http_request (urgent side only)
 *            -> approval_gate -> db_write
 */
function demoSteps() {
  return [
    {
      position: 0,
      name: "Classify the request",
      type: "llm_call",
      branch_key: null,
      config: {
        system:
          "You triage inbound support requests. Reply with exactly one word: URGENT or ROUTINE.",
        prompt: "Classify this request: {{trigger.text}}",
        temperature: 0,
        max_tokens: 16,
      },
    },
    {
      position: 1,
      name: "Is it urgent?",
      type: "conditional_branch",
      branch_key: null,
      config: { left: "{{last.text}}", operator: "contains", right: "URGENT" },
    },
    {
      position: 2,
      name: "Page the on-call service",
      type: "http_request",
      branch_key: "true",
      config: {
        method: "POST",
        url: "https://httpbin.org/post",
        body: { severity: "high", summary: "{{steps.0.output.text}}" },
      },
    },
    {
      position: 3,
      name: "Log to the routine queue",
      type: "http_request",
      branch_key: "false",
      config: {
        method: "POST",
        url: "https://httpbin.org/post",
        body: { severity: "normal", summary: "{{steps.0.output.text}}" },
      },
    },
    {
      position: 4,
      name: "Human approval",
      type: "approval_gate",
      branch_key: null,
      config: {
        instructions: "Confirm the triage decision before it is recorded.",
        approver_roles: ["owner", "editor"],
      },
    },
    {
      position: 5,
      name: "Record the outcome",
      type: "db_write",
      branch_key: null,
      config: {
        label: "triage-outcome",
        payload: {
          classification: "{{steps.0.output.text}}",
          urgent: "{{steps.1.output.result}}",
        },
      },
    },
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
  await adminGraphql(
    `mutation UpsertSteps($objects: [workflow_steps_insert_input!]!) {
       insert_workflow_steps(
         objects: $objects,
         on_conflict: {
           constraint: workflow_steps_workflow_id_position_key,
           update_columns: [name, type, config, branch_key]
         }
       ) { affected_rows }
     }`,
    { objects: steps.map((step) => ({ ...step, workflow_id: workflowId })) },
  );
  await adminGraphql(
    `mutation DropTail($workflowId: uuid!, $keep: Int!) {
       delete_workflow_steps(where: {workflow_id: {_eq: $workflowId}, position: {_gte: $keep}}) {
         affected_rows
       }
     }`,
    { workflowId, keep: steps.length },
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

  const seed = {
    password,
    orgA: { id: orgA, name: "Northwind Support", workflowId: workflowA },
    orgB: { id: orgB, name: "Contoso Logistics", workflowId: workflowB },
    users,
    webhookToken: token,
  };
  writeFileSync(resolve(repoRoot, ".foreman-seed.json"), JSON.stringify(seed, null, 2));

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

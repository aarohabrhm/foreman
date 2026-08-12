/**
 * Layer 2, proven through the real Action.
 *
 *   npm run verify:layer2
 *
 * The step-type and trigger-type restrictions live in lib/auth/layer2.ts and are
 * applied by the saveWorkflow handler. This drives that handler through Hasura
 * as real signed-in users, so it covers both directions: an editor is refused
 * the owner-only pieces, and an owner is allowed them.
 *
 * Everything it creates is deleted again at the end.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { signIn, userGraphql } from "./lib/auth.mjs";
import { adminGraphql } from "./lib/hasura.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const seed = JSON.parse(readFileSync(resolve(repoRoot, ".foreman-seed.json"), "utf8"));

const checks = [];
const check = (name, passed, detail = "") => {
  checks.push({ name, passed, detail });
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const SAVE = `mutation ($workflow: SaveWorkflowInput!) {
  saveWorkflow(workflow: $workflow) { workflow_id webhook_token }
}`;

const step = (position, name, type, config = {}) => ({
  position,
  name,
  type,
  config_json: JSON.stringify(config),
});

const created = [];

async function save(token, role, workflow) {
  const response = await userGraphql(token, SAVE, { workflow }, role);
  const id = response.data?.saveWorkflow?.workflow_id;
  if (id) created.push(id);
  return {
    id,
    token: response.data?.saveWorkflow?.webhook_token ?? null,
    error: response.errors?.[0]?.message ?? null,
  };
}

async function main() {
  const editor = (await signIn(seed.users.aEditor.email, seed.password)).session;
  const owner = (await signIn(seed.users.aOwner.email, seed.password)).session;
  const viewer = (await signIn(seed.users.aViewer.email, seed.password)).session;

  const base = {
    org_id: seed.orgA.id,
    description: "created by verify:layer2",
    triggers: [{ trigger_type: "manual", config_json: "{}", is_enabled: true }],
  };

  // --- The happy path, which everything else is measured against ------------
  const editorOk = await save(editor.accessToken, "editor", {
    ...base,
    name: "L2 editor workflow",
    steps: [
      step(0, "Classify", "llm_call", { prompt: "Say OK" }),
      step(1, "Check", "conditional_branch", { left: "{{last.text}}", operator: "contains", right: "OK" }),
      step(2, "Gate", "approval_gate", {}),
    ],
  });
  check(
    "an editor can create a workflow with the step types they are allowed",
    Boolean(editorOk.id),
    editorOk.error ?? editorOk.id,
  );

  // --- LAYER 2: step types only an owner may introduce ----------------------
  const editorDbWrite = await save(editor.accessToken, "editor", {
    ...base,
    name: "L2 editor db_write",
    steps: [step(0, "Write", "db_write", { label: "x", payload: {} })],
  });
  check(
    "an editor cannot add a db_write step",
    !editorDbWrite.id && /only an owner/i.test(editorDbWrite.error ?? ""),
    editorDbWrite.error ?? "ALLOWED",
  );

  const editorNotify = await save(editor.accessToken, "editor", {
    ...base,
    name: "L2 editor notify",
    steps: [step(0, "Tell", "notify", { message: "hi" })],
  });
  check(
    "an editor cannot add a notify step",
    !editorNotify.id && /only an owner/i.test(editorNotify.error ?? ""),
    editorNotify.error ?? "ALLOWED",
  );

  // --- LAYER 2: trigger types only an owner may configure -------------------
  const editorWebhook = await save(editor.accessToken, "editor", {
    ...base,
    name: "L2 editor webhook",
    steps: [step(0, "Classify", "llm_call", { prompt: "Say OK" })],
    triggers: [{ trigger_type: "webhook", config_json: "{}", is_enabled: true }],
  });
  check(
    "an editor cannot configure a webhook trigger",
    !editorWebhook.id && /only an owner/i.test(editorWebhook.error ?? ""),
    editorWebhook.error ?? "ALLOWED",
  );

  // --- The same submissions, as an owner, must succeed ----------------------
  const ownerAll = await save(owner.accessToken, "owner", {
    ...base,
    name: "L2 owner workflow",
    steps: [
      step(0, "Classify", "llm_call", { prompt: "Say OK" }),
      step(1, "Write", "db_write", { label: "x", payload: {} }),
      step(2, "Tell", "notify", { message: "hi" }),
    ],
    triggers: [{ trigger_type: "webhook", config_json: "{}", is_enabled: true }],
  });
  check(
    "an owner can add db_write, notify and a webhook trigger",
    Boolean(ownerAll.id),
    ownerAll.error ?? ownerAll.id,
  );
  check(
    "the webhook token is returned exactly once, at creation",
    typeof ownerAll.token === "string" && ownerAll.token.startsWith("fwh_"),
    ownerAll.token ? "token issued" : "no token returned",
  );

  if (ownerAll.id) {
    const resaved = await userGraphql(
      owner.accessToken,
      SAVE,
      {
        workflow: {
          ...base,
          workflow_id: ownerAll.id,
          name: "L2 owner workflow",
          steps: [step(0, "Classify", "llm_call", { prompt: "Say OK" })],
          triggers: [{ trigger_type: "webhook", config_json: "{}", is_enabled: true }],
        },
      },
      "owner",
    );
    check(
      "re-saving does not re-issue or rotate the webhook token",
      resaved.data?.saveWorkflow?.webhook_token === null,
      String(resaved.data?.saveWorkflow?.webhook_token),
    );
  }

  // --- Viewers cannot author at all ----------------------------------------
  const viewerSave = await save(viewer.accessToken, "viewer", {
    ...base,
    name: "L2 viewer workflow",
    steps: [step(0, "Classify", "llm_call", { prompt: "Say OK" })],
  });
  check(
    "a viewer cannot create a workflow",
    !viewerSave.id,
    viewerSave.error ?? "ALLOWED",
  );

  // --- Authoring into another org ------------------------------------------
  const crossOrg = await save(owner.accessToken, "owner", {
    ...base,
    org_id: seed.orgB.id,
    name: "L2 cross-org workflow",
    steps: [step(0, "Classify", "llm_call", { prompt: "Say OK" })],
  });
  check(
    "an Org A owner cannot create a workflow in Org B",
    !crossOrg.id && /not found/i.test(crossOrg.error ?? ""),
    crossOrg.error ?? "ALLOWED",
  );

  // --- Clean up -------------------------------------------------------------
  if (created.length) {
    const removed = await adminGraphql(
      `mutation ($ids: [uuid!]!) {
         delete_workflows(where: {id: {_in: $ids}}) { affected_rows }
       }`,
      { ids: created },
    );
    console.log(`\n  cleaned up ${removed.delete_workflows.affected_rows} test workflow(s).`);
  }

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

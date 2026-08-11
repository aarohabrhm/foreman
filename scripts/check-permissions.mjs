/**
 * Static audit of Layer 1: every permission rule must be scoped to the caller's
 * own organization AND to the role it is written for.
 *
 * "Role alone is never sufficient" is easy to state and easy to break with one
 * careless rule, so this asserts it mechanically across the whole metadata
 * directory. Run with:  npm run check:permissions
 */

import { loadOwnedMetadata } from "./lib/metadata.mjs";

/** `user` is the bootstrap role: it may only ever see rows keyed to itself. */
const BOOTSTRAP_ROLE = "user";
const SCOPED_ROLES = new Set(["owner", "editor", "viewer"]);

const failures = [];
const checked = [];

function auditExpression(context, role, expression) {
  const json = JSON.stringify(expression ?? {});

  if (!json.includes("X-Hasura-User-Id")) {
    failures.push(`${context}: no X-Hasura-User-Id — this rule is not scoped to the caller`);
    return;
  }

  if (role === BOOTSTRAP_ROLE) {
    if (json.includes('"role"')) {
      failures.push(`${context}: bootstrap role must not grant on org role`);
    }
    checked.push(context);
    return;
  }

  // The rule must constrain org_members.role to exactly the role it is for,
  // otherwise an editor could act through the owner rule and vice versa.
  if (!json.includes(`{"_eq":"${role}"}`)) {
    failures.push(`${context}: does not require an org_members row with role = ${role}`);
    return;
  }
  if (!json.includes('"members"')) {
    failures.push(`${context}: does not join org_members`);
    return;
  }
  checked.push(context);
}

const { tables } = loadOwnedMetadata();

for (const entry of tables) {
  const table = `${entry.table.schema}.${entry.table.name}`;

  for (const [kind, key] of [
    ["select_permissions", "filter"],
    ["insert_permissions", "check"],
    ["update_permissions", "filter"],
    ["update_permissions", "check"],
    ["delete_permissions", "filter"],
  ]) {
    for (const rule of entry[kind] ?? []) {
      const role = rule.role;
      const expression = rule.permission?.[key];
      const context = `${table} ${kind.replace("_permissions", "")}.${key} [${role}]`;

      // The one deliberate exception: any signed-in user may create an org.
      // A DB trigger (1786442400000_org_creator_membership) makes them its owner.
      if (table === "public.organizations" && kind === "insert_permissions" && role === BOOTSTRAP_ROLE) {
        checked.push(`${context} (bootstrap org creation — intentional)`);
        continue;
      }

      if (expression === undefined) continue;
      if (!SCOPED_ROLES.has(role) && role !== BOOTSTRAP_ROLE) {
        failures.push(`${context}: unexpected role`);
        continue;
      }
      auditExpression(context, role, expression);
    }
  }
}

console.log(`Layer 1 audit — ${checked.length} rule(s) checked across ${tables.length} tables.`);

if (failures.length) {
  console.error(`\n${failures.length} problem(s):`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exitCode = 1;
} else {
  console.log("All rules join org_members and pin the caller's role. ✓");
}

/**
 * Applies this project's SQL migrations and Hasura metadata to the configured
 * nhost project.  Run with:  npm run db:push
 *
 * Metadata is *merged*, never wholesale replaced: nhost owns the tracking and
 * permissions for its own auth/storage tables in the same Hasura instance, and
 * a blind `replace_metadata` would delete them. This script therefore exports
 * the live metadata, swaps in only the objects under nhost/metadata, and writes
 * the result back.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { metadataApi, runSql, hasuraBaseUrl } from "./lib/hasura.mjs";
import { loadOwnedMetadata, migrationsDir, ownedTableKeys } from "./lib/metadata.mjs";

const MIGRATIONS_TABLE = "public._foreman_migrations";

async function ensureMigrationsTable() {
  await runSql(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      version    text PRIMARY KEY,
      name       text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

async function appliedVersions() {
  const result = await runSql(`SELECT version FROM ${MIGRATIONS_TABLE};`);
  // run_sql returns { result_type, result: [[header], [row], ...] }
  const [, ...rows] = result.result ?? [[]];
  return new Set(rows.map(([version]) => version));
}

async function applyMigrations() {
  await ensureMigrationsTable();
  const applied = await appliedVersions();

  const dirs = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  let count = 0;
  for (const dir of dirs) {
    const [version, ...nameParts] = dir.split("_");
    if (applied.has(version)) {
      console.log(`  = ${dir} (already applied)`);
      continue;
    }
    const upPath = resolve(migrationsDir, dir, "up.sql");
    if (!existsSync(upPath)) continue;

    console.log(`  + ${dir}`);
    await runSql(readFileSync(upPath, "utf8"));
    await runSql(
      `INSERT INTO ${MIGRATIONS_TABLE} (version, name) VALUES ('${version}', '${nameParts.join("_")}');`,
    );
    count += 1;
  }
  return count;
}

function mergeByName(existing = [], incoming = [], key = "name") {
  const incomingNames = new Set(incoming.map((item) => item[key]));
  return [...existing.filter((item) => !incomingNames.has(item[key])), ...incoming];
}

async function applyMetadata() {
  const owned = loadOwnedMetadata();
  const live = await metadataApi("export_metadata", {});

  const source = live.sources?.find((entry) => entry.name === "default");
  if (!source) throw new Error("The Hasura instance has no `default` source");

  // Keep every table this project does not own (nhost's auth.* and storage.*).
  const ourKeys = ownedTableKeys(owned.tables);
  const foreignTables = (source.tables ?? []).filter(
    (entry) => !ourKeys.has(`${entry.table.schema}.${entry.table.name}`),
  );
  source.tables = [...foreignTables, ...owned.tables];

  const ownedActions = owned.actions?.actions ?? [];
  if (ownedActions.length) {
    live.actions = mergeByName(live.actions, ownedActions);
  }
  const ownedCustomTypes = owned.actions?.custom_types;
  if (ownedCustomTypes) {
    live.custom_types = live.custom_types ?? {};
    for (const kind of ["enums", "input_objects", "objects", "scalars"]) {
      if (ownedCustomTypes[kind]?.length) {
        live.custom_types[kind] = mergeByName(live.custom_types[kind], ownedCustomTypes[kind]);
      }
    }
  }
  if (owned.cronTriggers?.length) {
    live.cron_triggers = mergeByName(live.cron_triggers, owned.cronTriggers);
  }

  // Actions, Event Triggers and the cron trigger all resolve {{ACTION_BASE_URL}}
  // from a Hasura env var. Until that variable exists on the nhost side those
  // objects are inconsistent — and because replace_metadata is atomic, a strict
  // apply would also roll back the tables and permissions, which do not depend
  // on it. So: try strict first, and fall back to applying everything else while
  // reporting exactly what is still pending.
  let pending = [];
  try {
    await metadataApi("replace_metadata", live);
  } catch (error) {
    const inconsistencies = error.payload?.internal ?? [];
    const envVarOnly =
      inconsistencies.length > 0 &&
      inconsistencies.every((entry) => /environment variables not found/i.test(entry.reason ?? ""));
    if (!envVarOnly) throw error;

    await metadataApi("replace_metadata", {
      allow_inconsistent_metadata: true,
      metadata: live,
    });
    pending = inconsistencies.map((entry) => ({
      name: entry.name,
      reason: entry.reason.replace(/^Inconsistent object: /, ""),
    }));
  }

  return {
    tables: owned.tables.length,
    kept: foreignTables.length,
    actions: ownedActions.length,
    cronTriggers: owned.cronTriggers?.length ?? 0,
    pending,
  };
}

async function main() {
  console.log(`Target: ${hasuraBaseUrl()}`);

  console.log("\nMigrations:");
  const applied = await applyMigrations();
  console.log(applied ? `  ${applied} migration(s) applied.` : "  nothing to apply.");

  console.log("\nMetadata:");
  const summary = await applyMetadata();
  console.log(
    `  ${summary.tables} table(s) tracked, ${summary.kept} nhost-owned table(s) preserved, ` +
      `${summary.actions} action(s), ${summary.cronTriggers} cron trigger(s).`,
  );

  if (summary.pending.length) {
    console.log("\nPENDING — applied, but not yet active:");
    for (const entry of summary.pending) console.log(`  · ${entry.name}: ${entry.reason}`);
    console.log(
      "\nSet ACTION_BASE_URL (and ACTION_SECRET) in the nhost dashboard under\n" +
        "Settings -> Environment Variables, then re-run `npm run db:push`.\n" +
        "Until then the schema and both permission layers are live, but Actions,\n" +
        "Event Triggers and the cron trigger are not in the GraphQL schema.",
    );
    return;
  }

  console.log("\nDone — metadata is consistent.");
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});

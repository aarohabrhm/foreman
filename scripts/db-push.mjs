/**
 * Applies this project's SQL migrations and Hasura metadata to the configured
 * nhost project.  Run with:  npm run db:push
 *
 * Metadata is *merged*, never wholesale replaced: nhost owns the tracking and
 * permissions for its own auth/storage tables in the same Hasura instance, and
 * a blind `replace_metadata` would delete them. This script therefore exports
 * the live metadata, swaps in only the objects under nhost/metadata, and writes
 * the result back.
 *
 * Migrations run in two phases, either side of the metadata apply. A migration
 * that drops something the LIVE metadata still names — a column listed in a
 * permission, say — cannot run before that metadata is replaced: Hasura's
 * run_sql refuses it as having dependent objects (we call it with
 * `cascade: false` deliberately, so such a drop can never silently delete a
 * permission). Such a migration marks itself with the directive below and is
 * applied after the metadata that stops referencing it, in the same push.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { metadataApi, runSql, hasuraBaseUrl } from "./lib/hasura.mjs";
import { loadOwnedMetadata, migrationsDir, ownedTableKeys } from "./lib/metadata.mjs";

const MIGRATIONS_TABLE = "public._foreman_migrations";

/**
 * A migration whose up.sql contains this directive is held back until after
 * the metadata apply. See the file header.
 */
const AFTER_METADATA = "foreman:after-metadata";

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

/**
 * Every migration folder on disk, oldest first, paired with its SQL and with
 * the phase it belongs to.
 */
function readMigrations() {
  const dirs = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const migrations = [];
  for (const dir of dirs) {
    const upPath = resolve(migrationsDir, dir, "up.sql");
    if (!existsSync(upPath)) continue;

    const [version, ...nameParts] = dir.split("_");
    const sql = readFileSync(upPath, "utf8");
    migrations.push({
      dir,
      version,
      name: nameParts.join("_"),
      sql,
      afterMetadata: sql.includes(AFTER_METADATA),
    });
  }
  return migrations;
}

async function applyMigrations(phase) {
  await ensureMigrationsTable();
  const applied = await appliedVersions();

  let count = 0;
  for (const migration of readMigrations()) {
    if (migration.afterMetadata !== (phase === "after-metadata")) continue;
    if (applied.has(migration.version)) {
      console.log(`  = ${migration.dir} (already applied)`);
      continue;
    }

    console.log(`  + ${migration.dir}`);
    await runSql(migration.sql);
    await runSql(
      `INSERT INTO ${MIGRATIONS_TABLE} (version, name) VALUES ('${migration.version}', '${migration.name}');`,
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
  const applied = await applyMigrations("before-metadata");
  console.log(applied ? `  ${applied} migration(s) applied.` : "  nothing to apply.");

  console.log("\nMetadata:");
  const summary = await applyMetadata();
  console.log(
    `  ${summary.tables} table(s) tracked, ${summary.kept} nhost-owned table(s) preserved, ` +
      `${summary.actions} action(s), ${summary.cronTriggers} cron trigger(s).`,
  );

  // The metadata now live no longer names whatever these drop, so they can go.
  // Run them even when `summary.pending` is non-empty: the tables and their
  // permissions were applied either way, and only Actions and triggers are
  // held back by a missing env var.
  console.log("\nMigrations (after metadata):");
  const late = await applyMigrations("after-metadata");
  console.log(late ? `  ${late} migration(s) applied.` : "  nothing to apply.");

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

/**
 * Reads the committed Hasura metadata (nhost/metadata) into a JSON document.
 *
 * The files use the Hasura CLI's v3 layout, including its `"!include other.yaml"`
 * string convention, which this module resolves relative to the including file.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const metadataDir = resolve(repoRoot, "nhost/metadata");
export const migrationsDir = resolve(repoRoot, "nhost/migrations/default");

const INCLUDE = "!include ";

function resolveIncludes(node, baseDir) {
  if (Array.isArray(node)) {
    return node.map((item) => resolveIncludes(item, baseDir));
  }
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => [key, resolveIncludes(value, baseDir)]),
    );
  }
  if (typeof node === "string" && node.startsWith(INCLUDE)) {
    return loadYaml(resolve(baseDir, node.slice(INCLUDE.length).trim()));
  }
  return node;
}

export function loadYaml(filePath) {
  const parsed = YAML.parse(readFileSync(filePath, "utf8"));
  return resolveIncludes(parsed, dirname(filePath));
}

function loadOptional(relativePath, fallback) {
  const filePath = resolve(metadataDir, relativePath);
  return existsSync(filePath) ? loadYaml(filePath) : fallback;
}

/**
 * The parts of the live metadata this project owns. Everything else (nhost's
 * own auth/storage tracking) is left untouched by db-push.
 */
export function loadOwnedMetadata() {
  const databases = loadOptional("databases/databases.yaml", []);
  const defaultSource = databases.find((source) => source.name === "default");
  if (!defaultSource) throw new Error("nhost/metadata/databases/databases.yaml has no `default` source");

  return {
    tables: defaultSource.tables ?? [],
    actions: loadOptional("actions.yaml", { actions: [], custom_types: {} }),
    cronTriggers: loadOptional("cron_triggers.yaml", []),
  };
}

/** Table identifiers (schema.name) this project manages. */
export function ownedTableKeys(tables) {
  return new Set(tables.map((entry) => `${entry.table.schema}.${entry.table.name}`));
}

/**
 * Thin client for Hasura's admin HTTP APIs.
 *
 * We drive Hasura over these APIs rather than the hasura CLI so that setup is
 * `npm run db:push` on any platform, with no extra binary to install. The
 * committed files under nhost/ still use the standard Hasura CLI layout.
 */

const requiredEnv = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name} — copy .env.example to .env.local and fill it in`);
  return value;
};

/** Base URL of the project's Hasura, e.g. https://abc.hasura.eu-central-1.nhost.run */
export function hasuraBaseUrl() {
  if (process.env.HASURA_GRAPHQL_ENDPOINT) {
    return process.env.HASURA_GRAPHQL_ENDPOINT.replace(/\/+$/, "");
  }
  const subdomain = requiredEnv("NEXT_PUBLIC_NHOST_SUBDOMAIN");
  const region = requiredEnv("NEXT_PUBLIC_NHOST_REGION");
  return `https://${subdomain}.hasura.${region}.nhost.run`;
}

async function post(path, body) {
  const response = await fetch(`${hasuraBaseUrl()}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hasura-admin-secret": requiredEnv("HASURA_GRAPHQL_ADMIN_SECRET"),
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  if (!response.ok) {
    const detail = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
    const error = new Error(`Hasura ${path} failed (${response.status}): ${detail}`);
    error.payload = payload;
    throw error;
  }
  return payload;
}

/** Metadata API — tracking, relationships, permissions, actions, triggers. */
export const metadataApi = (type, args, extra = {}) => post("/v1/metadata", { type, args, ...extra });

/** Schema/query API — raw SQL against the `default` source. */
export const runSql = (sql) =>
  post("/v2/query", {
    type: "run_sql",
    args: { source: "default", sql, cascade: false, read_only: false },
  });

/** GraphQL as admin — used by the seed script. */
export async function adminGraphql(query, variables = {}) {
  const payload = await post("/v1/graphql", { query, variables });
  if (payload.errors?.length) {
    throw new Error(`GraphQL error: ${payload.errors.map((e) => e.message).join("; ")}`);
  }
  return payload.data;
}

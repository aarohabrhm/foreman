import "server-only";

import { createNhostClient, withAdminSession } from "@nhost/nhost-js";

import { nhostRegion, nhostSubdomain, serverEnv } from "@/lib/env";

/**
 * Admin-secret nhost client. Bypasses Hasura permissions entirely, so it is
 * confined to the Action/Event handlers, where it is used for two things the
 * caller's own role deliberately cannot do:
 *
 *   1. reading a caller's `org_members` row to decide authorization
 *      (the answer must not itself depend on the caller's permissions), and
 *   2. writing run/step state mid-execution.
 *
 * `server-only` makes importing this from a client component a build error.
 * Authorization decisions made with this client live in lib/auth/layer2.ts.
 */
let cached: ReturnType<typeof createNhostClient> | null = null;

function adminClient() {
  if (!cached) {
    cached = createNhostClient({
      subdomain: nhostSubdomain,
      region: nhostRegion,
      configure: [withAdminSession({ adminSecret: serverEnv.adminSecret() })],
    });
  }
  return cached;
}

/** Execute a GraphQL operation with admin rights, throwing on any GraphQL error. */
export async function adminGraphql<TData, TVariables extends Record<string, unknown> = Record<string, unknown>>(
  query: string,
  variables?: TVariables,
): Promise<TData> {
  const response = await adminClient().graphql.request<TData, TVariables>({ query, variables });

  if (response.body.errors?.length) {
    throw new Error(
      `Hasura admin request failed: ${response.body.errors.map((e) => e.message).join("; ")}`,
    );
  }
  if (!response.body.data) {
    throw new Error("Hasura admin request returned no data");
  }
  return response.body.data;
}

import { createClient } from "@nhost/nhost-js";

import { nhostRegion, nhostSubdomain } from "@/lib/env";

/**
 * Browser-side nhost client. Carries the signed-in user's session, so every
 * GraphQL request it makes is subject to Hasura's row-level rules (Layer 1).
 *
 * Requests are additionally tagged with `x-hasura-role` by `userGraphql()`
 * below: a user may hold different roles in different organizations, so the
 * role travels per request rather than being baked into the client.
 */
export const nhost = createClient({
  subdomain: nhostSubdomain,
  region: nhostRegion,
});

export type OrgRole = "owner" | "editor" | "viewer";

/**
 * Run a GraphQL operation as the signed-in user, acting in a specific role.
 *
 * Claiming a role here is not a privilege grant: Hasura only honours a role the
 * JWT lists in `x-hasura-allowed-roles`, and every permission rule additionally
 * requires a matching `org_members` row, so claiming `owner` against an org you
 * are not an owner of matches zero rows.
 */
export async function userGraphql<TData, TVariables extends Record<string, unknown> = Record<string, unknown>>(
  query: string,
  variables?: TVariables,
  role?: OrgRole,
): Promise<TData> {
  const response = await nhost.graphql.request<TData, TVariables>(
    { query, variables },
    role ? { headers: { "x-hasura-role": role } } : undefined,
  );

  if (response.body.errors?.length) {
    throw new Error(response.body.errors.map((e) => e.message).join("; "));
  }
  if (!response.body.data) {
    throw new Error("GraphQL response contained no data");
  }
  return response.body.data;
}

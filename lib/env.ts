/**
 * Central env access. Nothing in this repo reads process.env directly outside
 * this file, so a missing variable fails loudly and in one place.
 *
 * NEXT_PUBLIC_* values are referenced literally (not via a dynamic key) so that
 * Next.js can inline them into the client bundle.
 */

export const nhostSubdomain = process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN ?? "";
export const nhostRegion = process.env.NEXT_PUBLIC_NHOST_REGION ?? "";

/** GraphQL endpoint of the nhost project's Hasura, derived from subdomain/region. */
export function graphqlUrl(): string {
  if (!nhostSubdomain || !nhostRegion) {
    throw new Error(
      "NEXT_PUBLIC_NHOST_SUBDOMAIN and NEXT_PUBLIC_NHOST_REGION must be set (see .env.example)",
    );
  }
  return `https://${nhostSubdomain}.hasura.${nhostRegion}.nhost.run/v1/graphql`;
}

/** Same endpoint over websockets — used for the live step_runs subscription. */
export function graphqlWsUrl(): string {
  return graphqlUrl().replace(/^http/, "ws");
}

function requireServerEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required server env var ${name} (see .env.example)`);
  }
  return value;
}

export const serverEnv = {
  /** Hasura admin secret. Server-only — never import this from a client component. */
  adminSecret: () => requireServerEnv("HASURA_GRAPHQL_ADMIN_SECRET"),
  /** Shared secret proving an inbound request really came from Hasura. */
  actionSecret: () => requireServerEnv("ACTION_SECRET"),
  /** Optional: absent means llm_call steps run a disclosed stub. */
  groqApiKey: () => process.env.GROQ_API_KEY || null,
  groqModel: () => process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
  /** Optional: absent means notify steps log a disclosed stub. */
  slackWebhookUrl: () => process.env.SLACK_WEBHOOK_URL || null,
};

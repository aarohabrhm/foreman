import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Webhook trigger tokens.
 *
 * Only the SHA-256 hash is stored (`workflow_triggers.token_hash`, which no role
 * may select). The plaintext is returned exactly once, from saveWorkflow, at the
 * moment the trigger is created.
 */

export function generateWebhookToken(): string {
  return `fwh_${randomBytes(24).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function tokensMatch(provided: string, expectedHash: string): boolean {
  const a = Buffer.from(hashToken(provided));
  const b = Buffer.from(expectedHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

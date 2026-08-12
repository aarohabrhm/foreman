import "server-only";

import { timingSafeEqual } from "node:crypto";

import { waitUntil } from "@vercel/functions";

import { serverEnv } from "@/lib/env";
import { AuthorizationError } from "@/lib/auth/layer2";
import type { HasuraSessionVariables } from "@/lib/types";

/**
 * Shared plumbing for Hasura Action and Event Trigger handlers.
 *
 * Trust model: the handlers are ordinary public URLs, so they authenticate the
 * *caller* (Hasura) with a shared secret sent in a header that Hasura fills from
 * its own env var. Once that check passes, `session_variables` in the body is
 * trustworthy — Hasura derived it from the user's verified nhost JWT — which is
 * why the handlers take the caller's identity from there and never from the
 * request body's own fields.
 */

export interface ActionRequest<TInput> {
  input: TInput;
  userId: string | null;
  /** The role the caller was acting in when Hasura accepted the request. */
  role: string | null;
  actionName: string;
}

export class ActionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "action-error",
  ) {
    super(message);
    this.name = "ActionError";
  }
}

function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Rejects anything that did not come from our Hasura instance. */
export function assertCallerIsHasura(request: Request): void {
  const provided = request.headers.get("x-foreman-action-secret") ?? "";
  if (!provided || !secretsMatch(provided, serverEnv.actionSecret())) {
    throw new ActionError("Unauthorized caller", 401, "unauthorized");
  }
}

export async function readActionRequest<TInput>(request: Request): Promise<ActionRequest<TInput>> {
  assertCallerIsHasura(request);

  const body = (await request.json()) as {
    action?: { name?: string };
    input?: TInput;
    session_variables?: HasuraSessionVariables;
  };

  const session = body.session_variables ?? {};
  return {
    input: (body.input ?? {}) as TInput,
    userId: session["x-hasura-user-id"] ?? null,
    role: session["x-hasura-role"] ?? null,
    actionName: body.action?.name ?? "unknown",
  };
}

/** Hasura surfaces `message` to the GraphQL client; `code` lands in extensions. */
export function actionErrorResponse(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    console.warn(`[foreman] denied: ${error.message}`);
    return Response.json({ message: error.message, code: error.code }, { status: 403 });
  }
  if (error instanceof ActionError) {
    return Response.json({ message: error.message, code: error.code }, { status: error.status });
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error("[foreman] action handler failed:", error);
  return Response.json({ message, code: "internal-error" }, { status: 500 });
}

/** The app's own public origin, used to hand a run to a fresh invocation. */
function selfBaseUrl(): string {
  if (process.env.ACTION_BASE_URL) return process.env.ACTION_BASE_URL.replace(/\/+$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

/**
 * Hands a run to /api/hooks/execute and returns without waiting for it.
 *
 * A workflow run takes far longer than a Hasura Action should block for, so the
 * Action returns the run id immediately and progress reaches the client over the
 * step_runs subscription. The obvious way to do that — keep executing after
 * responding, via waitUntil — is NOT reliable on serverless: once the response
 * is sent the instance can be frozen mid-run, and a run that was created but
 * never executed sits at `pending` forever. That happened in production, and
 * intermittently, which is worse than failing outright.
 *
 * So execution happens in its own invocation, whose entire job is that run and
 * which therefore cannot be frozen by an unrelated response. The dispatching
 * request is abandoned after a moment: by then the callee has the whole request
 * and is working, and aborting only stops *us* waiting for its reply.
 */
export function dispatchRun(runId: string): void {
  const work = fetch(`${selfBaseUrl()}/api/hooks/execute`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-foreman-action-secret": serverEnv.actionSecret(),
    },
    body: JSON.stringify({ run_id: runId }),
    signal: AbortSignal.timeout(1500),
  }).catch((error: unknown) => {
    // An abort here is the expected path, not a failure.
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return;
    }
    console.error(`[foreman] could not dispatch run ${runId}:`, error);
  });

  // On Vercel this keeps the instance alive long enough to flush the request.
  try {
    waitUntil(work);
  } catch {
    /* not on Vercel; the dev server stays alive anyway */
  }
}

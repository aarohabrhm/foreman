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

/**
 * Runs work after the response has been sent.
 *
 * A workflow run takes far longer than a Hasura Action should block for, so the
 * handler returns the run id immediately and the engine keeps going in the
 * background — the client watches progress over the step_runs subscription.
 * On Vercel `waitUntil` keeps the function alive; locally it is a no-op and the
 * long-lived dev server runs the promise to completion either way.
 */
export function runInBackground(work: Promise<unknown>): void {
  const guarded = work.catch((error) => {
    console.error("[foreman] background execution failed:", error);
  });
  try {
    waitUntil(guarded);
  } catch {
    /* not running on Vercel — the promise still settles in-process */
  }
}

import "server-only";

import { adminGraphql } from "@/lib/nhost/admin";
import type { OrgMembership, OrgRole, StepType, TriggerType } from "@/lib/types";

/**
 * LAYER 2 — step-level gating enforced in application code.
 *
 * Layer 1 (nhost/metadata/**) answers "may this caller touch this row?" and is
 * declarative, per-row, and evaluated by Hasura on every request. It cannot
 * express the two rules below:
 *
 *   1. Which *kinds* of step or trigger a role may introduce is a property of
 *      the payload being authored, decided while assembling a whole workflow —
 *      several rows at once, some of which do not exist yet.
 *   2. Clearing an approval gate is a decision about a run that is mid-flight.
 *      Nothing is read or written at the moment of the decision; what follows is
 *      the resumption of execution. There is no row for Hasura to filter.
 *
 * Every function here is called from an Action handler, before any write.
 * They are deliberately small, named after the question they answer, and all in
 * one file so the enforcement points are trivial to audit.
 */

export class AuthorizationError extends Error {
  readonly code = "authorization-error";

  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

/** Step types only an `owner` may introduce into a workflow. */
const OWNER_ONLY_STEP_TYPES: readonly StepType[] = ["db_write", "notify"];

/** Trigger types only an `owner` may configure. */
const OWNER_ONLY_TRIGGER_TYPES: readonly TriggerType[] = ["webhook"];

/** Roles that may start a run. */
const RUN_TRIGGERING_ROLES: readonly OrgRole[] = ["owner", "editor"];

/** Roles that may clear an approval gate, unless the gate narrows it further. */
const DEFAULT_APPROVER_ROLES: readonly OrgRole[] = ["owner", "editor"];

/**
 * The caller's membership in an org, read with the admin client.
 *
 * This lookup must not run under the caller's own permissions: the answer to
 * "what is this user allowed to do" cannot itself be filtered by what they are
 * allowed to see, or an attacker learns the answer by making the question
 * return nothing.
 */
export async function loadMembership(userId: string, orgId: string): Promise<OrgMembership | null> {
  const data = await adminGraphql<{ org_members: OrgMembership[] }>(
    `query Membership($userId: uuid!, $orgId: uuid!) {
       org_members(where: {user_id: {_eq: $userId}, org_id: {_eq: $orgId}}, limit: 1) {
         org_id
         user_id
         role
       }
     }`,
    { userId, orgId },
  );
  return data.org_members[0] ?? null;
}

/**
 * The single message used both for "this row does not exist" and for "it exists
 * but not in an org you belong to".
 *
 * Cross-org isolation has to hold against ID guessing, so the two cases must be
 * indistinguishable to the caller — a distinct "forbidden" would confirm that
 * the ID is real.
 */
export function notFound(entity: string, id: string): AuthorizationError {
  return new AuthorizationError(`${entity} ${id} not found`);
}

/** LAYER 2 — only owner/editor may start a run; viewers are read-only. */
export function assertCanTriggerRun(membership: OrgMembership): void {
  if (!RUN_TRIGGERING_ROLES.includes(membership.role)) {
    throw new AuthorizationError(
      `Role '${membership.role}' cannot trigger runs — owner or editor required`,
    );
  }
}

/** LAYER 2 — db_write and notify steps may only be introduced by an owner. */
export function assertCanCreateStepType(role: OrgRole, stepType: StepType, stepName: string): void {
  if (role !== "owner" && OWNER_ONLY_STEP_TYPES.includes(stepType)) {
    throw new AuthorizationError(
      `Step '${stepName}': only an owner may add a '${stepType}' step (you are ${role})`,
    );
  }
}

/** LAYER 2 — webhook triggers may only be configured by an owner. */
export function assertCanConfigureTrigger(role: OrgRole, triggerType: TriggerType): void {
  if (role !== "owner" && OWNER_ONLY_TRIGGER_TYPES.includes(triggerType)) {
    throw new AuthorizationError(
      `Only an owner may configure a '${triggerType}' trigger (you are ${role})`,
    );
  }
}

/**
 * LAYER 2 — the approval decision itself.
 *
 * Called by the approveStep handler while a run sits at `paused`, before the
 * gate is stamped and execution resumes. A gate may narrow the default set via
 * its `approver_roles` config; it can never widen it beyond owner/editor.
 */
export function assertCanApprove(
  membership: OrgMembership,
  gateConfig: { approver_roles?: unknown } | null | undefined,
): void {
  const configured = Array.isArray(gateConfig?.approver_roles)
    ? (gateConfig.approver_roles as string[])
    : null;

  const allowed = configured
    ? DEFAULT_APPROVER_ROLES.filter((role) => configured.includes(role))
    : DEFAULT_APPROVER_ROLES;

  if (!allowed.includes(membership.role)) {
    throw new AuthorizationError(
      `Role '${membership.role}' cannot approve this step — ${allowed.join(" or ")} required`,
    );
  }
}

/**
 * LAYER 2 — quota. Not a row-level question either: it compares a counter on the
 * organization against its allowance at the moment a run is about to start.
 */
export function assertQuotaAvailable(org: {
  id: string;
  name: string;
  quota_used: number;
  quota_allowed: number;
}): void {
  if (org.quota_used >= org.quota_allowed) {
    throw new AuthorizationError(
      `Organization '${org.name}' has used its quota for this period ` +
        `(${org.quota_used}/${org.quota_allowed} runs). Raise the allowance or wait for the next period.`,
    );
  }
}

/** Shared vocabulary for the engine, the handlers and the UI. */

export const ORG_ROLES = ["owner", "editor", "viewer"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const STEP_TYPES = [
  "llm_call",
  "http_request",
  "db_write",
  "notify",
  "conditional_branch",
  "approval_gate",
] as const;
export type StepType = (typeof STEP_TYPES)[number];

export const TRIGGER_TYPES = ["manual", "webhook", "scheduled", "database_event"] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const RUN_STATUSES = ["pending", "running", "paused", "succeeded", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const STEP_RUN_STATUSES = [
  "pending",
  "running",
  "awaiting_approval",
  "succeeded",
  "failed",
  "skipped",
] as const;
export type StepRunStatus = (typeof STEP_RUN_STATUSES)[number];

export interface OrgMembership {
  org_id: string;
  user_id: string;
  role: OrgRole;
}

export interface WorkflowStep {
  id: string;
  workflow_id: string;
  position: number;
  name: string;
  type: StepType;
  config: Record<string, unknown>;
}

export interface StepRun {
  id: string;
  workflow_run_id: string;
  workflow_step_id: string;
  status: StepRunStatus;
  input: unknown;
  output: unknown;
  error: unknown;
  attempt_count: number;
  approved_by: string | null;
  approved_at: string | null;
}

/** Session variables Hasura sends in the Action/Event payload. */
export interface HasuraSessionVariables {
  "x-hasura-user-id"?: string;
  "x-hasura-role"?: string;
  [key: string]: string | undefined;
}

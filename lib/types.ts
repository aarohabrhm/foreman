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
  /** Stable per-workflow node id. What connections and templates refer to. */
  slug: string;
  /** Execution order — the graph's topological index, assigned by saveWorkflow. */
  position: number;
  name: string;
  type: StepType;
  config: Record<string, unknown>;
  /** Canvas coordinates. */
  ui_x: number;
  ui_y: number;
}

/** '' is an ordinary connection; 'true'/'false' leave a conditional_branch. */
export const EDGE_BRANCH_KEYS = ["", "true", "false"] as const;
export type EdgeBranchKey = (typeof EDGE_BRANCH_KEYS)[number];

export interface WorkflowStepEdge {
  id: string;
  workflow_id: string;
  from_slug: string;
  to_slug: string;
  branch_key: EdgeBranchKey;
}

export interface StepRun {
  id: string;
  workflow_run_id: string;
  workflow_step_id: string | null;
  position: number;
  /** Snapshot of the step's slug — survives the step being deleted or rewired. */
  step_slug: string;
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

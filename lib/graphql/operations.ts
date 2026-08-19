/**
 * Every GraphQL operation the frontend uses, in one place.
 *
 * The four operations the brief calls for are marked REQUIRED below.
 */

/** Bootstrap, run as nhost's default `user` role: which orgs am I in, and as what? */
export const MY_MEMBERSHIPS = `
  query MyMemberships {
    org_members(order_by: {created_at: asc}) {
      id
      org_id
      role
      invited_email
      org {
        id
        name
        quota_allowed
        quota_used
      }
    }
  }
`;

/**
 * REQUIRED #1 — an org's workflows with their steps, triggers and most recent
 * run status, plus the usage aggregate for the quota indicator.
 */
export const ORG_WORKFLOWS = `
  query OrgWorkflows($orgId: uuid!) {
    workflows(where: {org_id: {_eq: $orgId}}, order_by: {updated_at: desc}) {
      id
      name
      description
      updated_at
      steps(order_by: {position: asc}) {
        id
        position
        slug
        name
        type
        config
      }
      edges {
        id
      }
      triggers {
        id
        trigger_type
        config
        is_enabled
      }
      runs(order_by: {created_at: desc}, limit: 1) {
        id
        status
        trigger_type
        created_at
        finished_at
      }
    }
    org_usage_current_period(where: {org_id: {_eq: $orgId}}) {
      quota_allowed
      quota_used
      runs_remaining
      runs_this_period
      runs_succeeded_this_period
      avg_run_seconds_this_period
    }
  }
`;

/** One workflow, for the builder. */
export const WORKFLOW_DETAIL = `
  query WorkflowDetail($workflowId: uuid!) {
    workflows_by_pk(id: $workflowId) {
      id
      org_id
      name
      description
      steps(order_by: {position: asc}) {
        id
        position
        slug
        name
        type
        config
        ui_x
        ui_y
      }
      edges {
        id
        from_slug
        to_slug
        branch_key
      }
      triggers {
        id
        trigger_type
        config
        is_enabled
      }
      runs(order_by: {created_at: desc}, limit: 10) {
        id
        status
        trigger_type
        created_at
        finished_at
      }
    }
  }
`;

/**
 * REQUIRED #2 — create/edit a workflow, its steps and its triggers.
 *
 * A Hasura Action rather than a plain mutation: the Layer 2 step-type and
 * trigger-type restrictions have to see the whole submission before anything is
 * written. See lib/auth/layer2.ts.
 */
export const SAVE_WORKFLOW = `
  mutation SaveWorkflow($workflow: SaveWorkflowInput!) {
    saveWorkflow(workflow: $workflow) {
      workflow_id
      webhook_token
    }
  }
`;

/** Starts a run. Absent from the `viewer` role's permissions entirely. */
export const TRIGGER_WORKFLOW_RUN = `
  mutation TriggerWorkflowRun($workflowId: String!, $inputJson: String) {
    triggerWorkflowRun(workflow_id: $workflowId, input_json: $inputJson) {
      run_id
      status
    }
  }
`;

/** REQUIRED #3 — approve a paused approval_gate step and resume the run. */
export const APPROVE_STEP = `
  mutation ApproveStep($stepRunId: String!, $note: String) {
    approveStep(step_run_id: $stepRunId, note: $note) {
      run_id
      step_run_id
      status
    }
  }
`;

/**
 * REQUIRED #4 — live, step-by-step progress for one run, including the
 * "paused, awaiting approval" state (status = awaiting_approval).
 */
export const STEP_RUN_PROGRESS = `
  subscription StepRunProgress($runId: uuid!) {
    step_runs(where: {workflow_run_id: {_eq: $runId}}, order_by: {position: asc}) {
      id
      position
      workflow_step_id
      step_slug
      step_name
      step_type
      status
      attempt_count
      output
      error
      approved_by
      approved_at
      started_at
      finished_at
    }
  }
`;

/** Overall run status, multiplexed over the same websocket as the step feed. */
export const RUN_STATUS = `
  subscription RunStatus($runId: uuid!) {
    workflow_runs_by_pk(id: $runId) {
      id
      status
      error
      trigger_type
      started_at
      finished_at
      workflow {
        id
        name
        org_id
      }
    }
  }
`;

/** Live quota indicator. */
export const ORG_USAGE = `
  subscription OrgUsage($orgId: uuid!) {
    org_usage_current_period(where: {org_id: {_eq: $orgId}}) {
      quota_allowed
      quota_used
      runs_remaining
      runs_this_period
      avg_run_seconds_this_period
    }
  }
`;

/** Inserting a row here fires the database-event trigger. */
export const INSERT_WATCHED_RECORD = `
  mutation InsertWatchedRecord($orgId: uuid!, $label: String!, $payload: jsonb!) {
    insert_watched_records_one(object: {org_id: $orgId, label: $label, payload: $payload}) {
      id
      created_at
    }
  }
`;

export const CREATE_ORGANIZATION = `
  mutation CreateOrganization($name: String!) {
    insert_organizations_one(object: {name: $name}) {
      id
      name
    }
  }
`;

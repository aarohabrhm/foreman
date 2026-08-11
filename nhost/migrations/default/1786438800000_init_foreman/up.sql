-- Foreman: core schema.
--
-- Design notes:
--   * Every tenant-owned table can reach `org_members` in one or two hops, which
--     is what makes Hasura's row-level rules (Layer 1) expressible: no rule
--     grants access on role alone, each one joins the caller's membership row.
--   * `workflow_runs.org_id` and the snapshot columns on `step_runs` are
--     deliberate denormalisations, explained inline where they appear.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Standard updated_at trigger function.
CREATE OR REPLACE FUNCTION public.set_current_timestamp_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- organizations
-- ---------------------------------------------------------------------------
CREATE TABLE public.organizations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  -- Quota is "runs allowed per period". quota_used is the authoritative counter
  -- the engine increments when a run reaches a terminal state; the
  -- org_usage_current_period view recomputes the same number from workflow_runs
  -- as an independent cross-check.
  quota_allowed      integer NOT NULL DEFAULT 50 CHECK (quota_allowed >= 0),
  quota_used         integer NOT NULL DEFAULT 0 CHECK (quota_used >= 0),
  quota_period_start date NOT NULL DEFAULT date_trunc('month', now())::date,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER set_organizations_updated_at
  BEFORE UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

-- ---------------------------------------------------------------------------
-- org_members  — the table every permission rule joins against
-- ---------------------------------------------------------------------------
CREATE TABLE public.org_members (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  -- Email captured when the membership was created. auth.users is owned by
  -- nhost and is not exposed to these custom roles, so this is what the members
  -- list and the "approved by" label render.
  invited_email text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);

CREATE INDEX org_members_user_id_idx ON public.org_members (user_id);
CREATE INDEX org_members_org_id_idx ON public.org_members (org_id);

-- ---------------------------------------------------------------------------
-- workflows
-- ---------------------------------------------------------------------------
CREATE TABLE public.workflows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_by  uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX workflows_org_id_idx ON public.workflows (org_id);

CREATE TRIGGER set_workflows_updated_at
  BEFORE UPDATE ON public.workflows
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

-- ---------------------------------------------------------------------------
-- workflow_steps
-- ---------------------------------------------------------------------------
CREATE TABLE public.workflow_steps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.workflows (id) ON DELETE CASCADE,
  position    integer NOT NULL CHECK (position >= 0),
  name        text NOT NULL,
  type        text NOT NULL CHECK (type IN (
                'llm_call', 'http_request', 'db_write',
                'notify', 'conditional_branch', 'approval_gate')),
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Conditional execution: NULL means "always run". A step tagged 'true'/'false'
  -- runs only when the most recent conditional_branch evaluated to that value;
  -- otherwise the engine records it as 'skipped'.
  branch_key  text CHECK (branch_key IN ('true', 'false')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- Deferrable so a reorder can shuffle positions inside one transaction.
  CONSTRAINT workflow_steps_workflow_id_position_key
    UNIQUE (workflow_id, position) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX workflow_steps_workflow_id_idx ON public.workflow_steps (workflow_id);

CREATE TRIGGER set_workflow_steps_updated_at
  BEFORE UPDATE ON public.workflow_steps
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

-- ---------------------------------------------------------------------------
-- workflow_triggers
-- ---------------------------------------------------------------------------
CREATE TABLE public.workflow_triggers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id  uuid NOT NULL REFERENCES public.workflows (id) ON DELETE CASCADE,
  trigger_type text NOT NULL CHECK (trigger_type IN (
                 'manual', 'webhook', 'scheduled', 'database_event')),
  config       jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_enabled   boolean NOT NULL DEFAULT true,
  -- Webhook triggers authenticate with a bearer token issued once at creation.
  -- Only the SHA-256 hash is stored; the plaintext is shown to the owner once.
  token_hash   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX workflow_triggers_workflow_id_idx ON public.workflow_triggers (workflow_id);
CREATE UNIQUE INDEX workflow_triggers_token_hash_idx
  ON public.workflow_triggers (token_hash) WHERE token_hash IS NOT NULL;

CREATE TRIGGER set_workflow_triggers_updated_at
  BEFORE UPDATE ON public.workflow_triggers
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

-- ---------------------------------------------------------------------------
-- workflow_runs
-- ---------------------------------------------------------------------------
CREATE TABLE public.workflow_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id  uuid NOT NULL REFERENCES public.workflows (id) ON DELETE CASCADE,
  -- Denormalised from workflows: keeps the usage aggregate cheap and lets the
  -- permission rule on runs join org_members without a second hop.
  org_id       uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN (
                 'pending', 'running', 'paused', 'succeeded', 'failed')),
  trigger_type text NOT NULL DEFAULT 'manual' CHECK (trigger_type IN (
                 'manual', 'webhook', 'scheduled', 'database_event')),
  triggered_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  input        jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Accumulated step outputs plus the latest conditional_branch result. This is
  -- what makes resume-after-approval possible: everything the remaining steps
  -- need is persisted, so a second, unrelated process can pick the run up.
  context      jsonb NOT NULL DEFAULT '{}'::jsonb,
  error        text,
  started_at   timestamptz,
  finished_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX workflow_runs_workflow_id_idx ON public.workflow_runs (workflow_id);
CREATE INDEX workflow_runs_org_id_created_at_idx ON public.workflow_runs (org_id, created_at DESC);

CREATE TRIGGER set_workflow_runs_updated_at
  BEFORE UPDATE ON public.workflow_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

-- ---------------------------------------------------------------------------
-- step_runs
-- ---------------------------------------------------------------------------
CREATE TABLE public.step_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id uuid NOT NULL REFERENCES public.workflow_runs (id) ON DELETE CASCADE,
  workflow_step_id uuid REFERENCES public.workflow_steps (id) ON DELETE SET NULL,
  -- Snapshot of the step as it was when the run executed, so run history stays
  -- readable after the workflow is edited (and survives step deletion).
  position        integer NOT NULL,
  step_name       text NOT NULL,
  step_type       text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN (
                    'pending', 'running', 'awaiting_approval',
                    'succeeded', 'failed', 'skipped')),
  input           jsonb,
  output          jsonb,
  error           jsonb,
  attempt_count   integer NOT NULL DEFAULT 0,
  -- Approval-gate bookkeeping, written by the approveStep Action handler only.
  approved_by     uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  approved_at     timestamptz,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_run_id, position)
);

CREATE INDEX step_runs_workflow_run_id_idx ON public.step_runs (workflow_run_id);

CREATE TRIGGER set_step_runs_updated_at
  BEFORE UPDATE ON public.step_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

-- ---------------------------------------------------------------------------
-- db_write_results — where `db_write` steps land
-- ---------------------------------------------------------------------------
CREATE TABLE public.db_write_results (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  workflow_run_id uuid NOT NULL REFERENCES public.workflow_runs (id) ON DELETE CASCADE,
  step_run_id     uuid REFERENCES public.step_runs (id) ON DELETE SET NULL,
  label           text NOT NULL DEFAULT '',
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX db_write_results_org_id_idx ON public.db_write_results (org_id);

-- ---------------------------------------------------------------------------
-- watched_records — the table the database_event trigger watches
-- ---------------------------------------------------------------------------
CREATE TABLE public.watched_records (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  label      text NOT NULL DEFAULT '',
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX watched_records_org_id_idx ON public.watched_records (org_id);

-- ---------------------------------------------------------------------------
-- Aggregation: org usage for the current quota period
-- ---------------------------------------------------------------------------
CREATE VIEW public.org_usage_current_period AS
SELECT
  o.id                 AS org_id,
  o.quota_allowed,
  o.quota_used,
  o.quota_period_start,
  GREATEST(o.quota_allowed - o.quota_used, 0)              AS runs_remaining,
  count(r.id) FILTER (WHERE r.created_at >= o.quota_period_start)::int
                                                            AS runs_this_period,
  count(r.id) FILTER (WHERE r.created_at >= o.quota_period_start
                        AND r.status = 'succeeded')::int    AS runs_succeeded_this_period,
  avg(EXTRACT(EPOCH FROM (r.finished_at - r.started_at)))
    FILTER (WHERE r.finished_at IS NOT NULL
              AND r.created_at >= o.quota_period_start)      AS avg_run_seconds_this_period
FROM public.organizations o
LEFT JOIN public.workflow_runs r ON r.org_id = o.id
GROUP BY o.id;

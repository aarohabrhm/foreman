-- Outbox for `notify` steps.
--
-- The step enqueues a row here and returns immediately; a Hasura Event Trigger
-- on this table delivers it (Slack, or a disclosed stub) and stamps the result.
-- Delivery is therefore asynchronous and retried by Hasura rather than blocking
-- the run.

CREATE TABLE public.notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  workflow_run_id uuid REFERENCES public.workflow_runs (id) ON DELETE CASCADE,
  step_run_id     uuid REFERENCES public.step_runs (id) ON DELETE SET NULL,
  channel         text NOT NULL DEFAULT 'slack',
  message         text NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sent', 'stubbed', 'failed')),
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz
);

CREATE INDEX notifications_org_id_idx ON public.notifications (org_id);
CREATE INDEX notifications_workflow_run_id_idx ON public.notifications (workflow_run_id);

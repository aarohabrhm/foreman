-- Reverses 1786453200000_workflow_graph.
--
-- This is a rollback path, not a supported round trip. The linear model cannot
-- represent everything the graph can, so anything authored as a real DAG —
-- a fan-out with three arms, two independent conditionals, a step with two
-- unconditional predecessors — is flattened on the way back and loses meaning.

ALTER TABLE public.workflow_steps ADD COLUMN IF NOT EXISTS branch_key text;

-- Reconstruct the linear tag from the labelled connections. Only the FIRST step
-- of a branch arm carried the label in the graph, so a multi-step arm comes
-- back with just its head tagged and the rest degraded to "always run".
UPDATE public.workflow_steps s
SET branch_key = e.branch_key
FROM public.workflow_step_edges e
WHERE e.workflow_id = s.workflow_id AND e.to_slug = s.slug AND e.branch_key <> '';

ALTER TABLE public.workflow_steps
  ADD CONSTRAINT workflow_steps_branch_key_check CHECK (branch_key IN ('true', 'false'));

DROP TABLE public.workflow_step_edges;

ALTER TABLE public.step_runs DROP COLUMN step_slug;

ALTER TABLE public.workflow_steps DROP CONSTRAINT workflow_steps_workflow_id_slug_key;
ALTER TABLE public.workflow_steps DROP CONSTRAINT workflow_steps_slug_format;
ALTER TABLE public.workflow_steps
  DROP COLUMN slug,
  DROP COLUMN ui_x,
  DROP COLUMN ui_y;

-- Back to immediate: the old saveWorkflow used this as its ON CONFLICT arbiter.
ALTER TABLE public.workflow_steps
  DROP CONSTRAINT workflow_steps_workflow_id_position_key;
ALTER TABLE public.workflow_steps
  ADD CONSTRAINT workflow_steps_workflow_id_position_key UNIQUE (workflow_id, position);

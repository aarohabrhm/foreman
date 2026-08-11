ALTER TABLE public.workflow_steps
  DROP CONSTRAINT IF EXISTS workflow_steps_workflow_id_position_key;
ALTER TABLE public.workflow_steps
  ADD CONSTRAINT workflow_steps_workflow_id_position_key
  UNIQUE (workflow_id, position) DEFERRABLE INITIALLY DEFERRED;

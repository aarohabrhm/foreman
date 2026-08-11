-- workflow_steps (workflow_id, position) was created DEFERRABLE, on the theory
-- that a reorder might need to shuffle positions inside one transaction.
--
-- That was wrong twice over. Postgres refuses ON CONFLICT against a deferrable
-- constraint ("no unique or exclusion constraint matching the ON CONFLICT
-- specification"), which is how saveWorkflow and the seed upsert steps. And the
-- deferral was never needed: a position is a stable slot whose contents get
-- rewritten, not a value that moves between rows, so a reorder never holds two
-- rows at the same position even momentarily.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workflow_steps_workflow_id_position_key' AND condeferrable
  ) THEN
    ALTER TABLE public.workflow_steps
      DROP CONSTRAINT workflow_steps_workflow_id_position_key;
    ALTER TABLE public.workflow_steps
      ADD CONSTRAINT workflow_steps_workflow_id_position_key UNIQUE (workflow_id, position);
  END IF;
END $$;

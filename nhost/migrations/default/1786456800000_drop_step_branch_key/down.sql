-- Restores the column. The values are gone; 1786453200000_workflow_graph's
-- down.sql is what rebuilds them from the connections.
ALTER TABLE public.workflow_steps ADD COLUMN IF NOT EXISTS branch_key text;

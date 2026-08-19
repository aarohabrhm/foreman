-- Foreman: the workflow graph.
--
-- Replaces the linear steps list with a true DAG.
--
--   * workflow_steps gains a stable per-workflow `slug`. It is the identity the
--     canvas, the connections and the templates all use, and it becomes what
--     saveWorkflow upserts on.
--   * workflow_step_edges carries the connections, and the conditional label
--     moves off the STEP and onto the EDGE LEAVING the conditional_branch.
--     That is what lets one workflow hold two independent conditionals — the
--     old single `context.branch` flag could not, because the second one
--     silently overwrote the first.
--   * (workflow_id, position) becomes DEFERRABLE INITIALLY DEFERRED, and
--     (workflow_id, slug) takes its place as the ON CONFLICT arbiter.
--
-- On that last point, versus 1786449600000_step_position_not_deferrable: its
-- reasoning still holds — an ON CONFLICT arbiter index must be immediate — but
-- the arbiter has moved. Back then position WAS the identity, so it never had
-- to move between rows. It is now a derived value (the topological index the
-- Action assigns), and re-saving a rewired graph genuinely does shuffle it,
-- which is precisely the case a deferral exists for.
--
-- (workflow_id, slug) additionally has to be immediate for a second reason:
-- a foreign key can only reference a non-deferrable unique constraint — see
-- CREATE TABLE, "the referenced columns must be the columns of a non-deferrable
-- unique or primary key constraint" — and workflow_step_edges references it.

-- ---------------------------------------------------------------------------
-- 1. workflow_steps.slug
-- ---------------------------------------------------------------------------
ALTER TABLE public.workflow_steps ADD COLUMN slug text;

-- Slugify the name, then de-duplicate within the workflow.
--
-- Slugs are forced to start with a LETTER. That is not cosmetic: the run
-- context keys step output by slug and also by position, so that configs
-- written against the old list model ({{steps.0.output.text}}) keep resolving.
-- A step named "2" would slugify to "2" and land on top of position key 2.
-- Requiring a leading letter keeps the two key spaces disjoint.
--
-- Trimmed to 60, not 64, so the de-duplication suffix below still fits.
WITH base AS (
  SELECT
    id, workflow_id, position,
    COALESCE(
      NULLIF(btrim(regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'), '-'), ''),
      'step'
    ) AS raw
  FROM public.workflow_steps
),
candidate AS (
  SELECT
    id, workflow_id, position,
    btrim(left(CASE WHEN raw ~ '^[a-z]' THEN raw ELSE 'step-' || raw END, 60), '-') AS slug
  FROM base
),
numbered AS (
  SELECT
    id, slug,
    row_number() OVER (PARTITION BY workflow_id, slug ORDER BY position, id) AS n
  FROM candidate
)
UPDATE public.workflow_steps s
SET slug = CASE WHEN numbered.n = 1 THEN numbered.slug
                ELSE numbered.slug || '-' || numbered.n END
FROM numbered
WHERE s.id = numbered.id;

-- Safety net: a workflow holding both "Check" and "Check 2" makes the suffix
-- above collide with a real slug. Anything still duplicated takes a suffix
-- from its id instead, which cannot collide.
WITH dupes AS (
  SELECT id, row_number() OVER (PARTITION BY workflow_id, slug ORDER BY position, id) AS n
  FROM public.workflow_steps
)
UPDATE public.workflow_steps s
SET slug = left(s.slug, 51) || '-' || left(replace(s.id::text, '-', ''), 8)
FROM dupes
WHERE s.id = dupes.id AND dupes.n > 1;

ALTER TABLE public.workflow_steps ALTER COLUMN slug SET NOT NULL;

ALTER TABLE public.workflow_steps
  ADD CONSTRAINT workflow_steps_slug_format
  CHECK (slug ~ '^[a-z][a-z0-9_-]*$' AND length(slug) <= 64);

-- Immediate, not deferrable: this is both the ON CONFLICT arbiter saveWorkflow
-- upserts on and the target of workflow_step_edges' composite foreign keys.
ALTER TABLE public.workflow_steps
  ADD CONSTRAINT workflow_steps_workflow_id_slug_key UNIQUE (workflow_id, slug);

-- ---------------------------------------------------------------------------
-- 2. canvas coordinates
-- ---------------------------------------------------------------------------
ALTER TABLE public.workflow_steps
  ADD COLUMN ui_x double precision NOT NULL DEFAULT 0,
  ADD COLUMN ui_y double precision NOT NULL DEFAULT 0;

-- Lay the existing chain out left to right, with the two conditional arms
-- separated vertically, so the first canvas render of an old workflow is
-- readable rather than a pile of nodes at the origin.
UPDATE public.workflow_steps
SET ui_x = position * 260,
    ui_y = CASE branch_key WHEN 'true' THEN -110 WHEN 'false' THEN 110 ELSE 0 END;

-- ---------------------------------------------------------------------------
-- 3. workflow_step_edges
-- ---------------------------------------------------------------------------
CREATE TABLE public.workflow_step_edges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.workflows (id) ON DELETE CASCADE,
  from_slug   text NOT NULL,
  to_slug     text NOT NULL,
  -- '' = unconditional. 'true'/'false' = active only when the source
  -- conditional_branch evaluated that way.
  --
  -- NOT NULL DEFAULT '' rather than nullable: NULLs are distinct in a unique
  -- index, so a nullable label would let the very same connection be inserted
  -- twice, and a duplicate also double-counts indegree in the topological sort.
  branch_key  text NOT NULL DEFAULT '' CHECK (branch_key IN ('', 'true', 'false')),
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT workflow_step_edges_no_self_edge CHECK (from_slug <> to_slug),

  -- Named explicitly. The generated name would be 64 bytes, Postgres truncates
  -- identifiers to 63, and Hasura's on_conflict enum would then not match the
  -- constraint name the handler sends.
  CONSTRAINT workflow_step_edges_unique_edge
    UNIQUE (workflow_id, from_slug, to_slug, branch_key),

  -- workflow_id is part of BOTH foreign keys, so a connection structurally
  -- cannot point at a step in another workflow — and therefore not at another
  -- org's step either. Cross-org isolation on this table is a property of the
  -- schema rather than a rule that could be written wrongly.
  CONSTRAINT workflow_step_edges_from_fkey
    FOREIGN KEY (workflow_id, from_slug)
    REFERENCES public.workflow_steps (workflow_id, slug)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT workflow_step_edges_to_fkey
    FOREIGN KEY (workflow_id, to_slug)
    REFERENCES public.workflow_steps (workflow_id, slug)
    ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX workflow_step_edges_workflow_id_idx
  ON public.workflow_step_edges (workflow_id);

-- ---------------------------------------------------------------------------
-- 4. backfill the connections from the linear model
-- ---------------------------------------------------------------------------
-- The old rule was: a step runs if it is untagged, or if its tag equals the
-- branch value of the most recent conditional_branch executed before it — and
-- a skipped step never stopped the chain.
--
-- Naively wiring position i -> i+1 and moving branch_key onto that edge does
-- NOT reproduce this, and the seeded acceptance workflow is the counterexample:
-- with 2 -> 3 labelled 'false', taking the urgent branch skips step 3, whose
-- outgoing edge is then inactive, so the approval gate, the db_write and the
-- notify are ALL skipped. The whole tail of the demo dies.
--
-- The faithful translation is three rules:
--   * untagged step  -> unlabelled edge from the nearest preceding UNTAGGED
--                       step, i.e. the nearest step that always runs
--   * first tagged step with label L after conditional C -> edge C -> it [L]
--   * later tagged step with the same L under the same C -> unlabelled edge
--                       from the previous one
--
-- Every edge produced runs from a lower position to a higher one, so the result
-- is acyclic by construction.
--
-- One deliberate divergence: a step tagged 'true' with NO preceding conditional
-- used to be skipped forever. It now has no incoming edge, becomes a root and
-- runs. That configuration was already meaningless, and there are none in the
-- seeded data.
WITH marked AS (
  SELECT
    workflow_id, position, slug, type, branch_key,
    max(CASE WHEN type = 'conditional_branch' THEN position END)
      OVER (PARTITION BY workflow_id ORDER BY position
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS cond_pos,
    max(CASE WHEN branch_key IS NULL THEN position END)
      OVER (PARTITION BY workflow_id ORDER BY position
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_always_pos
  FROM public.workflow_steps
),
linked AS (
  SELECT
    m.*,
    lag(position) OVER (PARTITION BY workflow_id, cond_pos, branch_key
                        ORDER BY position) AS prev_same_branch_pos
  FROM marked m
),
wanted AS (
  SELECT workflow_id, prev_always_pos AS from_pos, position AS to_pos, '' AS branch_key
  FROM linked
  WHERE branch_key IS NULL AND prev_always_pos IS NOT NULL
  UNION ALL
  SELECT workflow_id, cond_pos, position, branch_key
  FROM linked
  WHERE branch_key IS NOT NULL AND cond_pos IS NOT NULL AND prev_same_branch_pos IS NULL
  UNION ALL
  SELECT workflow_id, prev_same_branch_pos, position, ''
  FROM linked
  WHERE branch_key IS NOT NULL AND prev_same_branch_pos IS NOT NULL
)
INSERT INTO public.workflow_step_edges (workflow_id, from_slug, to_slug, branch_key)
SELECT w.workflow_id, f.slug, t.slug, w.branch_key
FROM wanted w
JOIN public.workflow_steps f ON f.workflow_id = w.workflow_id AND f.position = w.from_pos
JOIN public.workflow_steps t ON t.workflow_id = w.workflow_id AND t.position = w.to_pos
ON CONFLICT ON CONSTRAINT workflow_step_edges_unique_edge DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5. step_runs snapshots the slug
-- ---------------------------------------------------------------------------
-- workflow_step_id is ON DELETE SET NULL, so after the workflow is edited the
-- live canvas overlay loses the link between a step_run and the node it came
-- from. The slug snapshot survives that, exactly as step_name and step_type
-- already do.
ALTER TABLE public.step_runs ADD COLUMN step_slug text NOT NULL DEFAULT '';

UPDATE public.step_runs r
SET step_slug = s.slug
FROM public.workflow_steps s
WHERE s.id = r.workflow_step_id;

-- ---------------------------------------------------------------------------
-- 6. (workflow_id, position) becomes deferrable
-- ---------------------------------------------------------------------------
-- Nothing may use this as an ON CONFLICT arbiter any more. It survives as the
-- backstop that keeps step_runs' UNIQUE (workflow_run_id, position) meaningful:
-- two steps sharing a position would make the engine's resume bookkeeping
-- ambiguous.
ALTER TABLE public.workflow_steps
  DROP CONSTRAINT workflow_steps_workflow_id_position_key;
ALTER TABLE public.workflow_steps
  ADD CONSTRAINT workflow_steps_workflow_id_position_key
  UNIQUE (workflow_id, position) DEFERRABLE INITIALLY DEFERRED;

-- NOTE: workflow_steps.branch_key is deliberately NOT dropped here.
-- See 1786456800000_drop_step_branch_key for why the drop has to wait until
-- after the metadata that still names the column has been replaced.

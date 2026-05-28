-- Tier 3 advisor compound runs: per-step results + partial status.

ALTER TABLE public.workflow_runs
  ADD COLUMN IF NOT EXISTS step_results jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.workflow_runs.step_results IS
  'Per-step outcomes for advisor compound actions: [{id,label,status,result,error}]';

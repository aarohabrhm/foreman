"use client";

import Link from "next/link";
import { use, useState } from "react";

import { useSession } from "@/components/SessionProvider";
import { Button, Card, Empty, ErrorNote, StatusPill, inputClass } from "@/components/ui";
import { APPROVE_STEP, RUN_STATUS, STEP_RUN_PROGRESS } from "@/lib/graphql/operations";
import { useGraphQLSubscription } from "@/lib/hooks";
import { userGraphql } from "@/lib/nhost/client";
import type { RunStatus, StepRunStatus, StepType } from "@/lib/types";

interface StepRunRow {
  id: string;
  position: number;
  step_name: string;
  step_type: StepType;
  status: StepRunStatus;
  attempt_count: number;
  output: unknown;
  error: unknown;
  approved_by: string | null;
  approved_at: string | null;
  started_at: string | null;
  finished_at: string | null;
}

interface RunRow {
  id: string;
  status: RunStatus;
  error: string | null;
  trigger_type: string;
  started_at: string | null;
  finished_at: string | null;
  workflow: { id: string; name: string; org_id: string } | null;
}

/**
 * Live run view.
 *
 * Everything on this page arrives over GraphQL subscriptions — the run's status
 * and each step_run as it changes. Nothing polls and nothing refetches after the
 * Run button: the Action returned only a run id, and progress is published by
 * the engine writing to the database.
 */
export default function RunPage({ params }: PageProps<"/runs/[runId]">) {
  const { runId } = use(params);
  const session = useSession();
  const role = session.role;

  const runStream = useGraphQLSubscription<{ workflow_runs_by_pk: RunRow | null }>(
    RUN_STATUS,
    { runId },
    role,
  );
  const stepStream = useGraphQLSubscription<{ step_runs: StepRunRow[] }>(
    STEP_RUN_PROGRESS,
    { runId },
    role,
  );

  const run = runStream.data?.workflow_runs_by_pk ?? null;
  const stepRuns = stepStream.data?.step_runs ?? [];
  const canApprove = role === "owner" || role === "editor";

  if (!session.ready) return <Empty>Loading…</Empty>;
  if (!session.signedIn) return <Empty>Sign in to continue.</Empty>;

  const streamError = runStream.error ?? stepStream.error;

  // A run in another organization simply does not exist for this session: the
  // subscription is filtered by the same Layer 1 rules as any query.
  if (runStream.live && !run) {
    return (
      <div className="space-y-3">
        <Link href="/workflows" className="text-sm underline underline-offset-4">
          ← Workflows
        </Link>
        <Empty>
          Run not found in {session.activeMembership?.org.name ?? "this organization"}.
        </Empty>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/workflows" className="text-sm underline underline-offset-4">
          ← Workflows
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">{run?.workflow?.name ?? "Run"}</h1>
        {run ? <StatusPill status={run.status} /> : null}
        <span className="ml-auto flex items-center gap-1.5 text-xs text-[var(--muted)]">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              stepStream.live ? "bg-emerald-500" : "bg-gray-400"
            }`}
          />
          {stepStream.live ? "live" : "connecting…"}
        </span>
      </div>

      <ErrorNote>{streamError}</ErrorNote>
      {run?.error ? <ErrorNote>{run.error}</ErrorNote> : null}

      {run ? (
        <p className="text-sm text-[var(--muted)]">
          Triggered {run.trigger_type}
          {run.started_at ? ` · started ${new Date(run.started_at).toLocaleTimeString()}` : ""}
          {run.finished_at ? ` · finished ${new Date(run.finished_at).toLocaleTimeString()}` : ""}
        </p>
      ) : null}

      <ol className="space-y-3">
        {stepRuns.map((stepRun) => (
          <li key={stepRun.id}>
            <StepRunCard stepRun={stepRun} canApprove={canApprove} />
          </li>
        ))}
      </ol>

      {stepRuns.length === 0 ? <Empty>Waiting for the first step…</Empty> : null}
    </div>
  );
}

function StepRunCard({ stepRun, canApprove }: { stepRun: StepRunRow; canApprove: boolean }) {
  const session = useSession();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const awaitingApproval = stepRun.status === "awaiting_approval";

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      // The role check that matters happens inside the approveStep handler
      // (assertCanApprove, lib/auth/layer2.ts) — this button only hides an
      // action a viewer's request would be refused for anyway.
      await userGraphql(
        APPROVE_STEP,
        { stepRunId: stepRun.id, note: note.trim() || null },
        session.role ?? undefined,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className={awaitingApproval ? "border-amber-500/60" : undefined}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-[var(--muted)]">{stepRun.position + 1}</span>
        <span className="font-medium">{stepRun.step_name}</span>
        <span className="rounded bg-black/5 px-1.5 py-0.5 font-mono text-xs dark:bg-white/10">
          {stepRun.step_type}
        </span>
        <StatusPill status={stepRun.status} />
        {stepRun.attempt_count > 1 ? (
          <span className="text-xs text-amber-600">
            {stepRun.attempt_count} attempts (retried)
          </span>
        ) : null}
        {stepRun.approved_at ? (
          <span className="text-xs text-[var(--muted)]">
            approved {new Date(stepRun.approved_at).toLocaleTimeString()}
          </span>
        ) : null}
      </div>

      {awaitingApproval ? (
        <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
          <p className="text-sm font-medium">This run is paused, awaiting approval.</p>
          {canApprove ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Optional note"
                className={`${inputClass} max-w-xs`}
              />
              <Button variant="primary" onClick={approve} disabled={busy}>
                {busy ? "Approving…" : "Approve and continue"}
              </Button>
            </div>
          ) : (
            <p className="mt-1 text-sm text-[var(--muted)]">
              Only an owner or editor in this organization can approve it.
            </p>
          )}
          <ErrorNote>{error}</ErrorNote>
        </div>
      ) : null}

      {stepRun.error ? (
        <pre className="mt-2 overflow-x-auto rounded bg-red-500/10 p-2 font-mono text-xs text-red-600 dark:text-red-300">
          {JSON.stringify(stepRun.error, null, 2)}
        </pre>
      ) : null}

      {stepRun.output ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-[var(--muted)]">output</summary>
          <pre className="mt-1 max-h-64 overflow-auto rounded bg-black/5 p-2 font-mono text-xs dark:bg-white/10">
            {JSON.stringify(stepRun.output, null, 2)}
          </pre>
        </details>
      ) : null}
    </Card>
  );
}

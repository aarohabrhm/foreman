"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { useSession } from "@/components/SessionProvider";
import { Button, Card, Empty, ErrorNote, Field, StatusPill, inputClass } from "@/components/ui";
import { CREATE_ORGANIZATION, INSERT_WATCHED_RECORD, ORG_WORKFLOWS } from "@/lib/graphql/operations";
import { useGraphQLQuery } from "@/lib/hooks";
import { userGraphql } from "@/lib/nhost/client";
import { STEP_LABELS, TRIGGER_LABELS } from "@/lib/stepTemplates";
import type { StepType, TriggerType } from "@/lib/types";

interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  updated_at: string;
  steps: { id: string; type: StepType; name: string; position: number; slug: string }[];
  edges: { id: string }[];
  triggers: { id: string; trigger_type: TriggerType; is_enabled: boolean }[];
  runs: { id: string; status: string; trigger_type: string; created_at: string }[];
}

export default function WorkflowsPage() {
  const session = useSession();
  const { data, error, loading, refetch } = useGraphQLQuery<{ workflows: WorkflowSummary[] }>(
    ORG_WORKFLOWS,
    session.activeOrgId ? { orgId: session.activeOrgId } : null,
    session.activeOrgId ? session.role : null,
  );

  if (!session.ready) return <Empty>Loading…</Empty>;
  if (!session.signedIn) {
    return (
      <Empty>
        <Link href="/sign-in" className="underline underline-offset-4">
          Sign in
        </Link>{" "}
        to continue.
      </Empty>
    );
  }

  if (session.memberships.length === 0) {
    return <CreateFirstOrganization onCreated={session.reloadMemberships} />;
  }

  const workflows = data?.workflows ?? [];
  const canEdit = session.role === "owner" || session.role === "editor";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Workflows</h1>
        <span className="text-sm text-[var(--muted)]">
          {session.activeMembership?.org.name} · you are {session.role}
        </span>
        {canEdit ? (
          <Link href="/workflows/new" className="ml-auto">
            <Button variant="primary">New workflow</Button>
          </Link>
        ) : (
          <span className="ml-auto text-xs text-[var(--muted)]">
            Viewers have read-only access.
          </span>
        )}
      </div>

      <ErrorNote>{error}</ErrorNote>
      {loading && !data ? <Empty>Loading workflows…</Empty> : null}

      {!loading && workflows.length === 0 ? (
        <Empty>No workflows in this organization yet.</Empty>
      ) : null}

      <div className="space-y-3">
        {workflows.map((workflow) => {
          const latestRun = workflow.runs[0];
          return (
            <Card key={workflow.id}>
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/workflows/${workflow.id}`}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {workflow.name}
                  </Link>
                  {workflow.description ? (
                    <p className="mt-0.5 text-sm text-[var(--muted)]">{workflow.description}</p>
                  ) : null}

                  {/* No "1. 2. 3." prefix any more: a workflow is a graph, and
                      numbering it as a list would contradict what the canvas shows
                      the moment it branches. */}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {workflow.steps.map((step) => (
                      <span
                        key={step.id}
                        title={step.name}
                        className="rounded bg-black/5 px-1.5 py-0.5 text-xs dark:bg-white/10"
                      >
                        {STEP_LABELS[step.type] ?? step.type}
                      </span>
                    ))}
                    {workflow.steps.length === 0 ? (
                      <span className="text-xs text-[var(--muted)]">no steps yet</span>
                    ) : (
                      <span className="text-xs text-[var(--muted)]">
                        {workflow.edges.length}{" "}
                        {workflow.edges.length === 1 ? "connection" : "connections"}
                      </span>
                    )}
                  </div>

                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {workflow.triggers.map((trigger) => (
                      <span
                        key={trigger.id}
                        className={`rounded border px-1.5 py-0.5 text-xs ${
                          trigger.is_enabled
                            ? "border-[var(--border)]"
                            : "border-dashed border-[var(--border)] text-[var(--muted)]"
                        }`}
                      >
                        {TRIGGER_LABELS[trigger.trigger_type] ?? trigger.trigger_type}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="text-right text-sm">
                  {latestRun ? (
                    <Link href={`/runs/${latestRun.id}`} className="inline-flex flex-col items-end gap-1">
                      <StatusPill status={latestRun.status} />
                      <span className="text-xs text-[var(--muted)]">
                        {latestRun.trigger_type} · {new Date(latestRun.created_at).toLocaleString()}
                      </span>
                    </Link>
                  ) : (
                    <span className="text-xs text-[var(--muted)]">never run</span>
                  )}
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      {canEdit ? <WatchedRecordPanel onInserted={refetch} /> : null}
    </div>
  );
}

/** Demonstrates the database-event trigger: inserting a row starts runs. */
function WatchedRecordPanel({ onInserted }: { onInserted: () => void }) {
  const session = useSession();
  const [label, setLabel] = useState("support-ticket");
  const [text, setText] = useState("The checkout API is down for all customers.");
  const [state, setState] = useState<{ error?: string; notice?: string }>({});
  const [busy, setBusy] = useState(false);

  async function insert() {
    if (!session.activeOrgId || !session.role) return;
    setBusy(true);
    setState({});
    try {
      await userGraphql(
        INSERT_WATCHED_RECORD,
        { orgId: session.activeOrgId, label, payload: { text } },
        session.role,
      );
      setState({ notice: "Row inserted — the Hasura Event Trigger starts any matching workflow." });
      onInserted();
    } catch (cause) {
      setState({ error: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="font-medium">Database-event trigger</h2>
      <p className="mt-0.5 mb-3 text-sm text-[var(--muted)]">
        Insert a row into <code className="font-mono text-xs">watched_records</code>. Hasura&apos;s
        Event Trigger starts every workflow in this org whose database_event trigger matches the
        label — no button click on the workflow itself.
      </p>
      <div className="grid gap-3 sm:grid-cols-[200px_1fr_auto] sm:items-end">
        <Field label="Label">
          <input value={label} onChange={(e) => setLabel(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Payload text">
          <input value={text} onChange={(e) => setText(e.target.value)} className={inputClass} />
        </Field>
        <Button onClick={insert} disabled={busy}>
          {busy ? "Inserting…" : "Insert row"}
        </Button>
      </div>
      <ErrorNote>{state.error}</ErrorNote>
      {state.notice ? <p className="mt-2 text-sm text-emerald-600">{state.notice}</p> : null}
    </Card>
  );
}

function CreateFirstOrganization({ onCreated }: { onCreated: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Runs as nhost's default `user` role: creating an org is the one insert
      // that cannot be scoped to an existing membership. A database trigger then
      // makes the creator its owner.
      await userGraphql(CREATE_ORGANIZATION, { name: name.trim() });
      onCreated();
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-md">
      <h1 className="mb-1 text-xl font-semibold tracking-tight">Create your organization</h1>
      <p className="mb-4 text-sm text-[var(--muted)]">
        You are not a member of any organization yet. Creating one makes you its owner.
      </p>
      <Card>
        <form onSubmit={create} className="space-y-4">
          <Field label="Organization name">
            <input
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              className={inputClass}
            />
          </Field>
          <ErrorNote>{error}</ErrorNote>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Creating…" : "Create organization"}
          </Button>
        </form>
      </Card>
    </div>
  );
}

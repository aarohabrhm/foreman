"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useMemo, useState } from "react";

import { Inspector } from "@/components/canvas/Inspector";
import { WorkflowCanvas } from "@/components/canvas/WorkflowCanvas";
import { autoLayout } from "@/components/canvas/geometry";
import {
  CLONE_OFFSET,
  useGraphEditor,
  type CanvasEdge,
  type CanvasNode,
} from "@/components/canvas/useGraphEditor";
import { useSession } from "@/components/SessionProvider";
import { Button, Card, Empty, ErrorNote, Field, StatusPill, inputClass } from "@/components/ui";
import { graphqlUrl } from "@/lib/env";
import { SAVE_WORKFLOW, TRIGGER_WORKFLOW_RUN, WORKFLOW_DETAIL } from "@/lib/graphql/operations";
import { useGraphQLQuery } from "@/lib/hooks";
import { userGraphql } from "@/lib/nhost/client";
import {
  OWNER_ONLY_TRIGGER_TYPES,
  TRIGGER_LABELS,
  defaultTriggerConfig,
} from "@/lib/stepTemplates";
import { TRIGGER_TYPES, type EdgeBranchKey, type StepType, type TriggerType } from "@/lib/types";

interface DraftTrigger {
  enabled: boolean;
  configJson: string;
}

interface LoadedWorkflow {
  id: string;
  org_id: string;
  name: string;
  description: string;
  steps: {
    id: string;
    position: number;
    slug: string;
    name: string;
    type: StepType;
    config: unknown;
    ui_x: number;
    ui_y: number;
  }[];
  edges: { id: string; from_slug: string; to_slug: string; branch_key: EdgeBranchKey }[];
  triggers: { id: string; trigger_type: TriggerType; config: unknown; is_enabled: boolean }[];
  runs: { id: string; status: string; trigger_type: string; created_at: string }[];
}

export default function WorkflowBuilderPage({ params }: PageProps<"/workflows/[id]">) {
  const { id } = use(params);
  const isNew = id === "new";
  const router = useRouter();
  const session = useSession();

  const { data, error, loading, refetch } = useGraphQLQuery<{
    workflows_by_pk: LoadedWorkflow | null;
  }>(WORKFLOW_DETAIL, isNew ? null : { workflowId: id }, isNew ? null : session.role);

  const loaded = data?.workflows_by_pk ?? null;

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const graph = useGraphEditor();
  const [triggers, setTriggers] = useState<Record<TriggerType, DraftTrigger>>(() =>
    Object.fromEntries(
      TRIGGER_TYPES.map((type) => [
        type,
        { enabled: type === "manual", configJson: defaultTriggerConfig(type) },
      ]),
    ) as Record<TriggerType, DraftTrigger>,
  );

  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [webhookToken, setWebhookToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Load the saved workflow into the draft exactly once per workflow. Adjusting
  // state during render (rather than in an effect) is the supported way to
  // derive state from freshly arrived data: React re-renders immediately with
  // the new values instead of painting a blank canvas first. Keyed on the
  // workflow id, so a refetch after saving never discards unsaved edits.
  const [hydratedId, setHydratedId] = useState<string | null>(null);
  if (loaded && hydratedId !== loaded.id) {
    setHydratedId(loaded.id);
    setName(loaded.name);
    setDescription(loaded.description ?? "");

    const edges: CanvasEdge[] = loaded.edges.map((edge) => ({
      id: edge.id,
      from: edge.from_slug,
      to: edge.to_slug,
      branch: edge.branch_key ?? "",
    }));

    // A workflow last saved before the canvas existed has every coordinate at
    // 0. Lay it out once rather than stacking every node on the origin; the
    // positions become real as soon as it is saved again.
    const untouched = loaded.steps.every((step) => !step.ui_x && !step.ui_y);
    const placed = untouched
      ? autoLayout(
          loaded.steps,
          loaded.edges.map((edge) => ({ from_slug: edge.from_slug, to_slug: edge.to_slug })),
        )
      : null;

    const nodes: CanvasNode[] = loaded.steps.map((step) => ({
      slug: step.slug,
      name: step.name,
      type: step.type,
      configJson: JSON.stringify(step.config ?? {}, null, 2),
      x: placed?.get(step.slug)?.x ?? step.ui_x,
      y: placed?.get(step.slug)?.y ?? step.ui_y,
    }));

    graph.dispatch({ type: "hydrate", nodes, edges });

    setTriggers(
      Object.fromEntries(
        TRIGGER_TYPES.map((type) => {
          const existing = loaded.triggers.find((trigger) => trigger.trigger_type === type);
          return [
            type,
            {
              enabled: Boolean(existing?.is_enabled),
              configJson: JSON.stringify(
                existing?.config ?? JSON.parse(defaultTriggerConfig(type)),
                null,
                2,
              ),
            },
          ];
        }),
      ) as Record<TriggerType, DraftTrigger>,
    );
  }

  const role = session.role;
  const canEdit = role === "owner" || role === "editor";
  const isOwner = role === "owner";
  const workflowId = isNew ? null : id;

  const curlExample = useMemo(() => {
    if (!webhookToken || !workflowId) return null;
    const body = JSON.stringify({
      query:
        "mutation ($id: String!, $token: String!, $payload: String) { startWorkflowViaWebhook(workflow_id: $id, token: $token, payload_json: $payload) { run_id status } }",
      variables: {
        id: workflowId,
        token: webhookToken,
        payload: '{"text":"The checkout API is down for all customers."}',
      },
    });
    return `curl -X POST ${graphqlUrl()} \\\n  -H 'content-type: application/json' \\\n  -d '${body}'`;
  }, [webhookToken, workflowId]);

  if (!session.ready) return <Empty>Loading…</Empty>;
  if (!session.signedIn) return <Empty>Sign in to continue.</Empty>;
  if (!isNew && !loading && !loaded) {
    return (
      <Empty>
        Workflow not found in {session.activeMembership?.org.name ?? "this organization"}.
      </Empty>
    );
  }

  async function save() {
    if (!session.activeOrgId) return;
    setBusy(true);
    setSaveError(null);
    setNotice(null);

    try {
      if (graph.problems.cycle.length) {
        throw new Error(
          `These steps loop back on themselves and cannot run: ${graph.problems.cycle.join(", ")}`,
        );
      }
      for (const node of graph.nodes) {
        try {
          JSON.parse(node.configJson || "{}");
        } catch {
          throw new Error(`Step "${node.name}": config is not valid JSON`);
        }
      }

      const result = await userGraphql<{
        saveWorkflow: { workflow_id: string; webhook_token: string | null };
      }>(
        SAVE_WORKFLOW,
        {
          workflow: {
            workflow_id: workflowId,
            org_id: session.activeOrgId,
            name: name.trim(),
            description,
            // `position` here is only the tiebreak for equally-ready steps —
            // the Action derives the real execution order from the connections.
            steps: graph.nodes.map((node, index) => ({
              position: index,
              slug: node.slug,
              name: node.name,
              type: node.type,
              config_json: node.configJson || "{}",
              ui_x: node.x,
              ui_y: node.y,
            })),
            edges: graph.edges.map((edge) => ({
              from_slug: edge.from,
              to_slug: edge.to,
              branch_key: edge.branch,
            })),
            triggers: TRIGGER_TYPES.filter((type) => triggers[type].enabled).map((type) => ({
              trigger_type: type,
              config_json: triggers[type].configJson || "{}",
              is_enabled: true,
            })),
          },
        },
        role ?? undefined,
      );

      if (result.saveWorkflow.webhook_token) setWebhookToken(result.saveWorkflow.webhook_token);
      setNotice("Saved.");

      if (isNew) {
        router.replace(`/workflows/${result.saveWorkflow.workflow_id}`);
      } else {
        refetch();
      }
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (!workflowId) return;
    setBusy(true);
    setSaveError(null);
    try {
      const result = await userGraphql<{ triggerWorkflowRun: { run_id: string } }>(
        TRIGGER_WORKFLOW_RUN,
        {
          workflowId,
          inputJson: JSON.stringify({ text: "The checkout API is down for all customers." }),
        },
        role ?? undefined,
      );
      router.push(`/runs/${result.triggerWorkflowRun.run_id}`);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/workflows" className="text-sm underline underline-offset-4">
          ← Workflows
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">
          {isNew ? "New workflow" : loaded?.name}
        </h1>

        <div className="ml-auto flex items-center gap-2">
          {canEdit ? (
            <Button onClick={save} disabled={busy || !name.trim()}>
              {busy ? "Working…" : "Save"}
            </Button>
          ) : null}

          {/*
            The Run button is hidden for viewers. This is presentation only —
            `viewer` has no insert permission on workflow_runs (Layer 1) and is
            not in triggerWorkflowRun's permitted roles, so a viewer calling the
            mutation by hand is refused regardless of what the UI shows.
          */}
          {canEdit && !isNew ? (
            <Button variant="primary" onClick={run} disabled={busy}>
              Run
            </Button>
          ) : null}
        </div>
      </div>

      <ErrorNote>{saveError ?? error}</ErrorNote>
      {notice ? <p className="text-sm text-emerald-600">{notice}</p> : null}

      {webhookToken ? (
        <Card className="border-amber-500/50">
          <h2 className="font-medium">Webhook token — shown once</h2>
          <p className="mt-0.5 text-sm text-[var(--muted)]">
            Only its SHA-256 hash is stored. Copy it now; re-saving will not show it again.
          </p>
          <pre className="mt-2 overflow-x-auto rounded bg-black/5 p-2 font-mono text-xs dark:bg-white/10">
            {webhookToken}
          </pre>
          {curlExample ? (
            <>
              <p className="mt-3 text-sm font-medium">Start a run from anywhere:</p>
              <pre className="mt-1 overflow-x-auto rounded bg-black/5 p-2 font-mono text-xs dark:bg-white/10">
                {curlExample}
              </pre>
            </>
          ) : null}
        </Card>
      ) : null}

      <Card>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={!canEdit}
              className={inputClass}
            />
          </Field>
          <Field label="Description">
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              disabled={!canEdit}
              className={inputClass}
            />
          </Field>
        </div>
      </Card>

      <Card className="p-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-3">
          <h2 className="font-medium">Steps</h2>
          <span className="text-xs text-[var(--muted)]">
            Drag a step&rsquo;s right-hand dot onto another to connect them. Drag the background to
            select several, space or the middle button to pan. A step runs once any connection into
            it is live; templates like {"{{steps.classify.output.text}}"} read an earlier step by its
            reference id.
          </span>
        </div>

        <div className="grid h-[620px] grid-rows-[1fr_auto] lg:grid-cols-[1fr_320px] lg:grid-rows-1">
          <div className="min-h-0 p-2">
            <WorkflowCanvas
              nodes={graph.nodes}
              edges={graph.edges}
              selected={graph.selected}
              selectedSet={graph.selectedSet}
              selectionFragment={graph.selectionFragment}
              problems={graph.problems}
              dispatch={graph.dispatch}
              canEdit={canEdit}
              isOwner={isOwner}
              canUndo={graph.canUndo}
              canRedo={graph.canRedo}
            />
          </div>

          <div className="min-h-0 border-t border-[var(--border)] lg:border-l lg:border-t-0">
            <Inspector
              node={graph.selectedNode}
              canEdit={canEdit}
              isOwner={isOwner}
              takenSlugs={graph.nodes.map((node) => node.slug)}
              selectedCount={graph.selected.length}
              onChange={(patch) =>
                graph.selectedNode
                  ? graph.dispatch({ type: "updateNode", slug: graph.selectedNode.slug, patch })
                  : undefined
              }
              onRenameSlug={(next) =>
                graph.selectedNode
                  ? graph.dispatch({ type: "renameSlug", slug: graph.selectedNode.slug, next })
                  : undefined
              }
              onDelete={() =>
                graph.selectedNode
                  ? graph.dispatch({ type: "deleteNode", slug: graph.selectedNode.slug })
                  : undefined
              }
              onDeleteSelection={() => graph.dispatch({ type: "deleteSelection" })}
              onDuplicate={() =>
                graph.dispatch({
                  type: "insertGraph",
                  fragment: graph.selectionFragment,
                  offset: { x: CLONE_OFFSET, y: CLONE_OFFSET },
                })
              }
            />
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="mb-3 font-medium">Triggers</h2>
        <div className="space-y-3">
          {TRIGGER_TYPES.map((type) => {
            const ownerOnly = !isOwner && OWNER_ONLY_TRIGGER_TYPES.includes(type);
            return (
              <div key={type} className="rounded-md border border-[var(--border)] p-3">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    checked={triggers[type].enabled}
                    disabled={!canEdit || ownerOnly}
                    onChange={(event) =>
                      setTriggers((current) => ({
                        ...current,
                        [type]: { ...current[type], enabled: event.target.checked },
                      }))
                    }
                  />
                  {TRIGGER_LABELS[type]}
                  {ownerOnly ? (
                    <span className="text-xs font-normal text-[var(--muted)]">(owner only)</span>
                  ) : null}
                </label>

                {triggers[type].enabled && type !== "manual" ? (
                  <textarea
                    value={triggers[type].configJson}
                    onChange={(event) =>
                      setTriggers((current) => ({
                        ...current,
                        [type]: { ...current[type], configJson: event.target.value },
                      }))
                    }
                    disabled={!canEdit}
                    rows={3}
                    spellCheck={false}
                    className={`${inputClass} mt-2 font-mono text-xs`}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      </Card>

      {loaded && loaded.runs.length > 0 ? (
        <Card>
          <h2 className="mb-3 font-medium">Recent runs</h2>
          <ul className="space-y-2">
            {loaded.runs.map((entry) => (
              <li key={entry.id} className="flex items-center gap-3 text-sm">
                <StatusPill status={entry.status} />
                <Link href={`/runs/${entry.id}`} className="underline underline-offset-4">
                  {new Date(entry.created_at).toLocaleString()}
                </Link>
                <span className="text-xs text-[var(--muted)]">via {entry.trigger_type}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

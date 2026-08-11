"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useMemo, useState } from "react";

import { useSession } from "@/components/SessionProvider";
import { Button, Card, Empty, ErrorNote, Field, StatusPill, inputClass } from "@/components/ui";
import { graphqlUrl } from "@/lib/env";
import { SAVE_WORKFLOW, TRIGGER_WORKFLOW_RUN, WORKFLOW_DETAIL } from "@/lib/graphql/operations";
import { useGraphQLQuery } from "@/lib/hooks";
import { userGraphql } from "@/lib/nhost/client";
import {
  OWNER_ONLY_STEP_TYPES,
  OWNER_ONLY_TRIGGER_TYPES,
  STEP_HINTS,
  STEP_LABELS,
  TRIGGER_LABELS,
  defaultStepConfig,
  defaultTriggerConfig,
} from "@/lib/stepTemplates";
import { STEP_TYPES, TRIGGER_TYPES, type StepType, type TriggerType } from "@/lib/types";

interface DraftStep {
  key: string;
  name: string;
  type: StepType;
  configJson: string;
  branchKey: "" | "true" | "false";
}

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
    name: string;
    type: StepType;
    config: unknown;
    branch_key: string | null;
  }[];
  triggers: { id: string; trigger_type: TriggerType; config: unknown; is_enabled: boolean }[];
  runs: { id: string; status: string; trigger_type: string; created_at: string }[];
}

const newKey = () => Math.random().toString(36).slice(2);

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
  const [steps, setSteps] = useState<DraftStep[]>([]);
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
  // the new values instead of painting a blank form first. Keyed on the
  // workflow id, so a refetch after saving never discards unsaved edits.
  const [hydratedId, setHydratedId] = useState<string | null>(null);
  if (loaded && hydratedId !== loaded.id) {
    setHydratedId(loaded.id);
    setName(loaded.name);
    setDescription(loaded.description ?? "");
    setSteps(
      loaded.steps.map((step) => ({
        key: step.id,
        name: step.name,
        type: step.type,
        configJson: JSON.stringify(step.config ?? {}, null, 2),
        branchKey: (step.branch_key as "true" | "false" | null) ?? "",
      })),
    );
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

  function addStep(type: StepType) {
    setSteps((current) => [
      ...current,
      {
        key: newKey(),
        name: STEP_LABELS[type],
        type,
        configJson: defaultStepConfig(type),
        branchKey: "",
      },
    ]);
  }

  function updateStep(key: string, patch: Partial<DraftStep>) {
    setSteps((current) =>
      current.map((step) => (step.key === key ? { ...step, ...patch } : step)),
    );
  }

  function moveStep(index: number, delta: number) {
    setSteps((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = current.slice();
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function save() {
    if (!session.activeOrgId) return;
    setBusy(true);
    setSaveError(null);
    setNotice(null);

    try {
      for (const step of steps) {
        try {
          JSON.parse(step.configJson || "{}");
        } catch {
          throw new Error(`Step "${step.name}": config is not valid JSON`);
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
            steps: steps.map((step, index) => ({
              position: index,
              name: step.name,
              type: step.type,
              config_json: step.configJson || "{}",
              branch_key: step.branchKey || null,
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

      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="font-medium">Steps</h2>
          <span className="text-xs text-[var(--muted)]">
            Executed top to bottom. Templates like {"{{last.text}}"} read earlier output.
          </span>
        </div>

        <div className="space-y-3">
          {steps.map((step, index) => (
            <div key={step.key} className="rounded-md border border-[var(--border)] p-3">
              <div className="flex flex-wrap items-end gap-2">
                <div className="w-8 pb-2 text-sm text-[var(--muted)]">{index + 1}</div>

                <div className="min-w-40 flex-1">
                  <Field label="Name">
                    <input
                      value={step.name}
                      onChange={(event) => updateStep(step.key, { name: event.target.value })}
                      disabled={!canEdit}
                      className={inputClass}
                    />
                  </Field>
                </div>

                <div className="min-w-44">
                  <Field label="Type">
                    <select
                      value={step.type}
                      onChange={(event) =>
                        updateStep(step.key, {
                          type: event.target.value as StepType,
                          configJson: defaultStepConfig(event.target.value as StepType),
                        })
                      }
                      disabled={!canEdit}
                      className={inputClass}
                    >
                      {STEP_TYPES.map((type) => (
                        <option
                          key={type}
                          value={type}
                          disabled={!isOwner && OWNER_ONLY_STEP_TYPES.includes(type)}
                        >
                          {STEP_LABELS[type]}
                          {!isOwner && OWNER_ONLY_STEP_TYPES.includes(type) ? " (owner only)" : ""}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>

                <div className="min-w-32">
                  <Field label="Runs on branch">
                    <select
                      value={step.branchKey}
                      onChange={(event) =>
                        updateStep(step.key, {
                          branchKey: event.target.value as DraftStep["branchKey"],
                        })
                      }
                      disabled={!canEdit}
                      className={inputClass}
                    >
                      <option value="">always</option>
                      <option value="true">if true</option>
                      <option value="false">if false</option>
                    </select>
                  </Field>
                </div>

                {canEdit ? (
                  <div className="flex gap-1 pb-0.5">
                    <Button onClick={() => moveStep(index, -1)} disabled={index === 0}>
                      ↑
                    </Button>
                    <Button onClick={() => moveStep(index, 1)} disabled={index === steps.length - 1}>
                      ↓
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() =>
                        setSteps((current) => current.filter((entry) => entry.key !== step.key))
                      }
                    >
                      Remove
                    </Button>
                  </div>
                ) : null}
              </div>

              <p className="mt-2 text-xs text-[var(--muted)]">{STEP_HINTS[step.type]}</p>

              <textarea
                value={step.configJson}
                onChange={(event) => updateStep(step.key, { configJson: event.target.value })}
                disabled={!canEdit}
                rows={Math.min(12, step.configJson.split("\n").length + 1)}
                spellCheck={false}
                className={`${inputClass} mt-2 font-mono text-xs`}
              />
            </div>
          ))}

          {steps.length === 0 ? <Empty>No steps yet.</Empty> : null}
        </div>

        {canEdit ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {STEP_TYPES.map((type) => (
              <Button
                key={type}
                onClick={() => addStep(type)}
                disabled={!isOwner && OWNER_ONLY_STEP_TYPES.includes(type)}
                title={
                  !isOwner && OWNER_ONLY_STEP_TYPES.includes(type)
                    ? "Only an owner may add this step type"
                    : undefined
                }
              >
                + {STEP_LABELS[type]}
              </Button>
            ))}
          </div>
        ) : null}
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

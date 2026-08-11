import { ActionError, actionErrorResponse, readActionRequest } from "@/lib/actions/handler";
import { generateWebhookToken, hashToken } from "@/lib/actions/tokens";
import {
  AuthorizationError,
  assertCanConfigureTrigger,
  assertCanCreateStepType,
  loadMembership,
  notFound,
} from "@/lib/auth/layer2";
import { adminGraphql } from "@/lib/nhost/admin";
import { STEP_TYPES, TRIGGER_TYPES, type StepType, type TriggerType } from "@/lib/types";

interface StepInput {
  position: number;
  name: string;
  type: string;
  config_json?: string | null;
  branch_key?: string | null;
}

interface TriggerInput {
  trigger_type: string;
  config_json?: string | null;
  is_enabled?: boolean | null;
}

interface Input {
  workflow: {
    workflow_id?: string | null;
    org_id?: string;
    name?: string;
    description?: string | null;
    steps?: StepInput[];
    triggers?: TriggerInput[];
  };
}

/**
 * Hasura Action: saveWorkflow(workflow)
 *
 * Authoring goes through an Action rather than plain Hasura mutations because
 * the step-type and trigger-type restrictions are Layer 2 rules: they depend on
 * the caller's role AND on what is being authored, across a whole set of rows
 * submitted together. assertCanCreateStepType / assertCanConfigureTrigger below
 * are the enforcement points; the equivalent clauses in the Hasura metadata are
 * only a backstop for hand-written mutations.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const { input, userId } = await readActionRequest<Input>(request);
    if (!userId) throw new ActionError("Not signed in", 401, "unauthenticated");

    const payload = input.workflow ?? {};
    const orgId = payload.org_id?.trim();
    const name = payload.name?.trim();
    if (!orgId) throw new ActionError("org_id is required");
    if (!name) throw new ActionError("name is required");

    const membership = await loadMembership(userId, orgId);
    if (!membership) throw notFound("Organization", orgId);
    if (membership.role === "viewer") {
      throw new AuthorizationError("Role 'viewer' cannot create or edit workflows");
    }

    const steps = normaliseSteps(payload.steps ?? []);
    const triggers = normaliseTriggers(payload.triggers ?? []);

    // ---- LAYER 2: which step and trigger types this role may introduce ------
    for (const step of steps) {
      assertCanCreateStepType(membership.role, step.type, step.name);
    }
    for (const trigger of triggers) {
      assertCanConfigureTrigger(membership.role, trigger.trigger_type);
    }

    const workflowId = await upsertWorkflow({
      workflowId: payload.workflow_id?.trim() || null,
      orgId,
      name,
      description: payload.description ?? "",
      userId,
    });

    await replaceSteps(workflowId, steps);
    const webhookToken = await replaceTriggers(workflowId, triggers);

    return Response.json({ workflow_id: workflowId, webhook_token: webhookToken });
  } catch (error) {
    return actionErrorResponse(error);
  }
}

interface NormalisedStep {
  position: number;
  name: string;
  type: StepType;
  config: unknown;
  branch_key: string | null;
}

function parseConfig(raw: string | null | undefined, label: string): unknown {
  if (!raw?.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ActionError(`${label}: config is not valid JSON`);
  }
}

function normaliseSteps(steps: StepInput[]): NormalisedStep[] {
  return steps
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((step, index) => {
      const name = step.name?.trim() || `Step ${index + 1}`;
      if (!STEP_TYPES.includes(step.type as StepType)) {
        throw new ActionError(`${name}: unknown step type '${step.type}'`);
      }
      const branchKey = step.branch_key?.trim() || null;
      if (branchKey && branchKey !== "true" && branchKey !== "false") {
        throw new ActionError(`${name}: branch_key must be 'true', 'false' or empty`);
      }
      return {
        // Positions are renumbered densely so a reorder in the UI cannot leave
        // gaps or collide with the (workflow_id, position) unique constraint.
        position: index,
        name,
        type: step.type as StepType,
        config: parseConfig(step.config_json, name),
        branch_key: branchKey,
      };
    });
}

interface NormalisedTrigger {
  trigger_type: TriggerType;
  config: unknown;
  is_enabled: boolean;
}

function normaliseTriggers(triggers: TriggerInput[]): NormalisedTrigger[] {
  const seen = new Set<string>();
  return triggers.map((trigger) => {
    if (!TRIGGER_TYPES.includes(trigger.trigger_type as TriggerType)) {
      throw new ActionError(`Unknown trigger type '${trigger.trigger_type}'`);
    }
    if (seen.has(trigger.trigger_type)) {
      throw new ActionError(`Duplicate '${trigger.trigger_type}' trigger`);
    }
    seen.add(trigger.trigger_type);
    return {
      trigger_type: trigger.trigger_type as TriggerType,
      config: parseConfig(trigger.config_json, `${trigger.trigger_type} trigger`),
      is_enabled: trigger.is_enabled ?? true,
    };
  });
}

async function upsertWorkflow(options: {
  workflowId: string | null;
  orgId: string;
  name: string;
  description: string;
  userId: string;
}): Promise<string> {
  if (options.workflowId) {
    const existing = await adminGraphql<{ workflows_by_pk: { id: string; org_id: string } | null }>(
      `query ExistingWorkflow($workflowId: uuid!) {
         workflows_by_pk(id: $workflowId) { id org_id }
       }`,
      { workflowId: options.workflowId },
    );

    // The workflow must live in the org the caller was authorized against —
    // otherwise an editor in org A could edit org B's workflow by passing its id.
    if (!existing.workflows_by_pk || existing.workflows_by_pk.org_id !== options.orgId) {
      throw notFound("Workflow", options.workflowId);
    }

    await adminGraphql(
      `mutation UpdateWorkflow($workflowId: uuid!, $patch: workflows_set_input!) {
         update_workflows_by_pk(pk_columns: {id: $workflowId}, _set: $patch) { id }
       }`,
      {
        workflowId: options.workflowId,
        patch: { name: options.name, description: options.description },
      },
    );
    return options.workflowId;
  }

  const created = await adminGraphql<{ insert_workflows_one: { id: string } }>(
    `mutation CreateWorkflow($object: workflows_insert_input!) {
       insert_workflows_one(object: $object) { id }
     }`,
    {
      object: {
        org_id: options.orgId,
        name: options.name,
        description: options.description,
        created_by: options.userId,
      },
    },
  );
  return created.insert_workflows_one.id;
}

/**
 * Upserts on (workflow_id, position) and drops the tail, rather than deleting
 * and re-inserting every step: step ids stay stable, so a paused run can still
 * resolve the gate it stopped at.
 */
async function replaceSteps(workflowId: string, steps: NormalisedStep[]): Promise<void> {
  if (steps.length) {
    await adminGraphql(
      `mutation UpsertSteps($objects: [workflow_steps_insert_input!]!) {
         insert_workflow_steps(
           objects: $objects,
           on_conflict: {
             constraint: workflow_steps_workflow_id_position_key,
             update_columns: [name, type, config, branch_key]
           }
         ) { affected_rows }
       }`,
      {
        objects: steps.map((step) => ({
          workflow_id: workflowId,
          position: step.position,
          name: step.name,
          type: step.type,
          config: step.config,
          branch_key: step.branch_key,
        })),
      },
    );
  }

  await adminGraphql(
    `mutation DropRemovedSteps($workflowId: uuid!, $keep: Int!) {
       delete_workflow_steps(where: {workflow_id: {_eq: $workflowId}, position: {_gte: $keep}}) {
         affected_rows
       }
     }`,
    { workflowId, keep: steps.length },
  );
}

/** Returns the plaintext webhook token if one was minted by this save. */
async function replaceTriggers(
  workflowId: string,
  triggers: NormalisedTrigger[],
): Promise<string | null> {
  const existing = await adminGraphql<{
    workflow_triggers: { id: string; trigger_type: TriggerType; token_hash: string | null }[];
  }>(
    `query ExistingTriggers($workflowId: uuid!) {
       workflow_triggers(where: {workflow_id: {_eq: $workflowId}}) { id trigger_type token_hash }
     }`,
    { workflowId },
  );

  const existingByType = new Map(existing.workflow_triggers.map((row) => [row.trigger_type, row]));

  let plaintextToken: string | null = null;
  const objects = triggers.map((trigger) => {
    const previous = existingByType.get(trigger.trigger_type);
    let tokenHash = previous?.token_hash ?? null;

    // A webhook trigger needs a token; it is minted once and only its hash is
    // stored, so re-saving the workflow does not rotate or re-reveal it.
    if (trigger.trigger_type === "webhook" && !tokenHash) {
      plaintextToken = generateWebhookToken();
      tokenHash = hashToken(plaintextToken);
    }

    return {
      workflow_id: workflowId,
      trigger_type: trigger.trigger_type,
      config: trigger.config,
      is_enabled: trigger.is_enabled,
      token_hash: tokenHash,
    };
  });

  if (objects.length) {
    await adminGraphql(
      `mutation UpsertTriggers($objects: [workflow_triggers_insert_input!]!) {
         insert_workflow_triggers(
           objects: $objects,
           on_conflict: {
             constraint: workflow_triggers_workflow_id_trigger_type_key,
             update_columns: [config, is_enabled, token_hash]
           }
         ) { affected_rows }
       }`,
      { objects },
    );
  }

  const keep = triggers.map((trigger) => trigger.trigger_type);
  await adminGraphql(
    `mutation DropRemovedTriggers($workflowId: uuid!, $keep: [String!]!) {
       delete_workflow_triggers(
         where: {workflow_id: {_eq: $workflowId}, trigger_type: {_nin: $keep}}
       ) { affected_rows }
     }`,
    { workflowId, keep: keep.length ? keep : ["__none__"] },
  );

  return plaintextToken;
}

import { ActionError, actionErrorResponse, readActionRequest } from "@/lib/actions/handler";
import { generateWebhookToken, hashToken } from "@/lib/actions/tokens";
import {
  AuthorizationError,
  assertCanConfigureTrigger,
  assertCanCreateStepType,
  loadMembership,
  notFound,
} from "@/lib/auth/layer2";
import {
  GraphCycleError,
  type GraphEdge,
  isValidSlug,
  slugify,
  topologicalOrder,
  uniqueSlug,
} from "@/lib/engine/graph";
import { adminGraphql } from "@/lib/nhost/admin";
import { STEP_TYPES, TRIGGER_TYPES, type StepType, type TriggerType } from "@/lib/types";

interface StepInput {
  position: number;
  name: string;
  type: string;
  config_json?: string | null;
  slug?: string | null;
  ui_x?: number | null;
  ui_y?: number | null;
  /** DEPRECATED — see deriveLegacyEdges. */
  branch_key?: string | null;
}

interface EdgeInput {
  from_slug: string;
  to_slug: string;
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
    edges?: EdgeInput[];
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
 *
 * It is also where the workflow's shape is decided. The client sends steps and
 * the connections between them; this handler rejects a graph that cannot run
 * (a loop, a connection to nowhere) and derives each step's `position` from a
 * topological sort, so what reaches the database is always in a valid execution
 * order. The engine re-derives that order anyway — see lib/engine/graph.ts.
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

    const rawSteps = payload.steps ?? [];
    const steps = normaliseSteps(rawSteps);
    const edges = normaliseEdges(
      payload.edges?.length ? payload.edges : deriveLegacyEdges(rawSteps, steps),
      steps,
    );
    // Assigns the execution order, and is where a loop is refused.
    const ordered = orderSteps(steps, edges);
    const triggers = normaliseTriggers(payload.triggers ?? []);

    // ---- LAYER 2: which step and trigger types this role may introduce ------
    for (const step of ordered) {
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

    // Order matters, and not only for the foreign keys.
    //
    // Each of these is its own transaction, so the DEFERRABLE unique on
    // (workflow_id, position) is checked at the end of EACH ONE, not at the end
    // of the save. Removing steps first is what keeps the upsert's own commit
    // conflict-free: shrinking [a,b,c,d] to [b,c,d] would otherwise write b into
    // position 0 while the old b still sat at position 1.
    await clearEdges(workflowId);
    await pruneSteps(workflowId, ordered);
    await replaceSteps(workflowId, ordered);
    await replaceEdges(workflowId, edges);
    const webhookToken = await replaceTriggers(workflowId, triggers);

    return Response.json({ workflow_id: workflowId, webhook_token: webhookToken });
  } catch (error) {
    return actionErrorResponse(error);
  }
}

interface NormalisedStep {
  slug: string;
  position: number;
  name: string;
  type: StepType;
  config: unknown;
  ui_x: number;
  ui_y: number;
}

function parseConfig(raw: string | null | undefined, label: string): unknown {
  if (!raw?.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ActionError(`${label}: config is not valid JSON`);
  }
}

const finite = (value: number | null | undefined): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/**
 * Validates the steps and settles every slug.
 *
 * Explicit slugs are reserved in a first pass so that a derived one can never
 * squat on a slug the client actually asked for. An explicit duplicate is an
 * error rather than something to de-duplicate: two nodes claiming one id means
 * the canvas is confused, and silently merging them loses a step.
 */
function normaliseSteps(steps: StepInput[]): NormalisedStep[] {
  const taken = new Set<string>();

  for (const step of steps) {
    const requested = step.slug?.trim();
    if (!requested) continue;
    if (!isValidSlug(requested)) {
      throw new ActionError(
        `Step "${step.name?.trim() || requested}": id must start with a letter and use only ` +
          `lowercase letters, digits, '-' or '_'`,
      );
    }
    if (taken.has(requested)) throw new ActionError(`Two steps share the id '${requested}'`);
    taken.add(requested);
  }

  return steps.map((step, index) => {
    const name = step.name?.trim() || `Step ${index + 1}`;
    if (!STEP_TYPES.includes(step.type as StepType)) {
      throw new ActionError(`${name}: unknown step type '${step.type}'`);
    }

    const requested = step.slug?.trim();
    const slug = requested || uniqueSlug(slugify(name, `step-${index + 1}`), taken);

    return {
      slug,
      // The submitted order, kept only as the tiebreak for the topological
      // sort. orderSteps overwrites this with the real execution index.
      position: index,
      name,
      type: step.type as StepType,
      config: parseConfig(step.config_json, name),
      ui_x: finite(step.ui_x),
      ui_y: finite(step.ui_y),
    };
  });
}

function normaliseEdges(edges: EdgeInput[], steps: NormalisedStep[]): GraphEdge[] {
  const typeBySlug = new Map(steps.map((step) => [step.slug, step.type]));
  const nameBySlug = new Map(steps.map((step) => [step.slug, step.name]));
  const seen = new Set<string>();

  return edges.map((edge) => {
    const from = edge.from_slug?.trim();
    const to = edge.to_slug?.trim();
    if (!from || !to) throw new ActionError("A connection is missing one of its ends");
    for (const slug of [from, to]) {
      if (!typeBySlug.has(slug)) {
        throw new ActionError(`A connection references an unknown step '${slug}'`);
      }
    }
    if (from === to) {
      throw new ActionError(`"${nameBySlug.get(from)}" cannot connect to itself`);
    }

    const branchKey = edge.branch_key?.trim() || "";
    if (branchKey !== "" && branchKey !== "true" && branchKey !== "false") {
      throw new ActionError(`A connection's branch must be 'true', 'false' or empty`);
    }
    // A labelled connection leaving anything else is a permanent dead end —
    // nothing will ever set a branch value for that step, so the destination
    // could never run and the UI would have no way to explain why.
    if (branchKey && typeBySlug.get(from) !== "conditional_branch") {
      throw new ActionError(
        `Only a conditional branch has true/false outputs — "${nameBySlug.get(from)}" does not`,
      );
    }

    // Not silently de-duplicated: a repeat also double-counts the destination's
    // indegree, which would leave it stuck in the topological sort.
    const key = `${from}\u0000${to}\u0000${branchKey}`;
    if (seen.has(key)) {
      throw new ActionError(
        `Duplicate connection from "${nameBySlug.get(from)}" to "${nameBySlug.get(to)}"`,
      );
    }
    seen.add(key);

    return { from_slug: from, to_slug: to, branch_key: branchKey };
  });
}

/**
 * Rebuilds the graph a pre-canvas client implies by sending `branch_key` on the
 * steps themselves and no connections at all.
 *
 * The old rule was: a step runs if it is untagged, or if its tag matches the
 * most recent conditional_branch — and a skipped step never stopped the chain.
 * Wiring i -> i+1 and moving the tag onto that edge does NOT reproduce it,
 * because the arm that is skipped would then take the whole tail with it. The
 * faithful translation is the same three rules the migration backfill uses:
 *
 *   * untagged step -> from the nearest preceding UNTAGGED step
 *   * first tagged step with label L after conditional C -> from C, labelled L
 *   * a later step with the same label under the same C -> from the previous one
 *
 * Drop this once nothing sends the old shape.
 */
function deriveLegacyEdges(raw: StepInput[], steps: NormalisedStep[]): EdgeInput[] {
  if (!raw.some((step) => step.branch_key?.trim())) {
    // No tags at all: a plain chain, which is what the list UI always meant.
    return steps.slice(1).map((step, index) => ({
      from_slug: steps[index].slug,
      to_slug: step.slug,
    }));
  }

  const edges: EdgeInput[] = [];
  const armTail = new Map<string, string>();
  let previousAlways: string | null = null;
  let conditional: string | null = null;

  steps.forEach((step, index) => {
    const branchKey = raw[index]?.branch_key?.trim() || "";

    if (!branchKey) {
      if (previousAlways) edges.push({ from_slug: previousAlways, to_slug: step.slug });
      previousAlways = step.slug;
    } else {
      const arm = `${conditional ?? ""}\u0000${branchKey}`;
      const tail = armTail.get(arm);
      if (tail) {
        edges.push({ from_slug: tail, to_slug: step.slug });
      } else if (conditional) {
        edges.push({ from_slug: conditional, to_slug: step.slug, branch_key: branchKey });
      }
      armTail.set(arm, step.slug);
    }

    // Set last: a conditional's own incoming edge comes from what preceded it.
    if (step.type === "conditional_branch") conditional = step.slug;
  });

  return edges;
}

/** Assigns the execution order. Rejects a graph that cannot produce one. */
function orderSteps(steps: NormalisedStep[], edges: GraphEdge[]): NormalisedStep[] {
  try {
    return topologicalOrder(steps, edges).map((step, index) => ({ ...step, position: index }));
  } catch (error) {
    if (error instanceof GraphCycleError) {
      const names = new Map(steps.map((step) => [step.slug, step.name]));
      throw new ActionError(
        `The workflow loops back on itself: ${error.slugs
          .map((slug) => `"${names.get(slug) ?? slug}"`)
          .join(", ")}`,
      );
    }
    throw error;
  }
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
 * Connections are rewritten wholesale rather than diffed: an edge carries no
 * identity worth preserving, and clearing them first means replaceSteps can
 * delete a step without tripping the foreign keys that point at its slug.
 */
async function clearEdges(workflowId: string): Promise<void> {
  await adminGraphql(
    `mutation ClearEdges($workflowId: uuid!) {
       delete_workflow_step_edges(where: {workflow_id: {_eq: $workflowId}}) { affected_rows }
     }`,
    { workflowId },
  );
}

/** Drops the steps this save left out. Keyed on slug, because position moves. */
async function pruneSteps(workflowId: string, steps: NormalisedStep[]): Promise<void> {
  const keep = steps.map((step) => step.slug);
  await adminGraphql(
    `mutation DropRemovedSteps($workflowId: uuid!, $keep: [String!]!) {
       delete_workflow_steps(where: {workflow_id: {_eq: $workflowId}, slug: {_nin: $keep}}) {
         affected_rows
       }
     }`,
    { workflowId, keep: keep.length ? keep : ["__none__"] },
  );
}

/**
 * Upserts on (workflow_id, slug) rather than deleting and re-inserting, so a
 * step's row id follows the NODE. That is what lets a run paused at an approval
 * gate still resolve the step it stopped at, even if the graph was rewired
 * around it in the meantime — and it is stronger than the old upsert on
 * position, where a reorder rewrote the contents of a slot and a paused run's
 * workflow_step_id could end up pointing at a different step entirely.
 */
async function replaceSteps(workflowId: string, steps: NormalisedStep[]): Promise<void> {
  if (!steps.length) return;

  await adminGraphql(
    `mutation UpsertSteps($objects: [workflow_steps_insert_input!]!) {
       insert_workflow_steps(
         objects: $objects,
         on_conflict: {
           constraint: workflow_steps_workflow_id_slug_key,
           update_columns: [name, type, config, position, ui_x, ui_y]
         }
       ) { affected_rows }
     }`,
    {
      objects: steps.map((step) => ({
        workflow_id: workflowId,
        slug: step.slug,
        position: step.position,
        name: step.name,
        type: step.type,
        config: step.config,
        ui_x: step.ui_x,
        ui_y: step.ui_y,
      })),
    },
  );
}

async function replaceEdges(workflowId: string, edges: GraphEdge[]): Promise<void> {
  if (!edges.length) return;

  await adminGraphql(
    `mutation InsertEdges($objects: [workflow_step_edges_insert_input!]!) {
       insert_workflow_step_edges(
         objects: $objects,
         on_conflict: {constraint: workflow_step_edges_unique_edge, update_columns: []}
       ) { affected_rows }
     }`,
    {
      // update_columns: [] makes a conflict a no-op, so a retried save after a
      // partial failure is idempotent rather than an error.
      objects: edges.map((edge) => ({
        workflow_id: workflowId,
        from_slug: edge.from_slug,
        to_slug: edge.to_slug,
        branch_key: edge.branch_key,
      })),
    },
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

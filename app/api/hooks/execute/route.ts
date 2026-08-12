import { actionErrorResponse, assertCallerIsHasura } from "@/lib/actions/handler";
import { executeRun } from "@/lib/engine/executor";

// Long enough for a workflow of real steps; the run pauses at an approval gate
// rather than blocking here indefinitely.
export const maxDuration = 300;

/**
 * Executes one run, synchronously, in an invocation dedicated to it.
 *
 * This is where every trigger ends up. Keeping execution in its own request is
 * what makes it reliable on serverless: nothing here races a response that has
 * already been sent, so a run cannot be created and then silently abandoned.
 *
 * Callers are the Action handlers (via dispatchRun), authenticated with the same
 * shared secret Hasura uses — assertCallerIsHasura enforces it, so this endpoint
 * is not a way for anyone else to drive runs.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertCallerIsHasura(request);

    const body = (await request.json()) as { run_id?: string };
    const runId = body.run_id?.trim();
    if (!runId) return Response.json({ message: "run_id is required" }, { status: 400 });

    const status = await executeRun(runId);
    return Response.json({ run_id: runId, status });
  } catch (error) {
    return actionErrorResponse(error);
  }
}

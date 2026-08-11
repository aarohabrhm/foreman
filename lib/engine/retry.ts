/**
 * Retry wrapper for the two step types that make real external calls.
 *
 * The attempt count is reported back so it can be persisted on the step_run —
 * a run that succeeded on its second attempt should say so in the UI.
 */

export interface RetryOptions {
  /** Total attempts, including the first. Two = "at least one retry". */
  attempts?: number;
  /** Base delay between attempts; doubles each time. */
  delayMs?: number;
  /** Called before each retry, for logging. */
  onRetry?: (error: unknown, attempt: number) => void;
}

export interface RetryResult<T> {
  value: T;
  attempts: number;
}

export class StepExecutionError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "StepExecutionError";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<RetryResult<T>> {
  const attempts = options.attempts ?? 2;
  const delayMs = options.delayMs ?? 750;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const value = await operation(attempt);
      return { value, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        options.onRetry?.(error, attempt);
        await sleep(delayMs * attempt);
      }
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new StepExecutionError(message, attempts, lastError);
}

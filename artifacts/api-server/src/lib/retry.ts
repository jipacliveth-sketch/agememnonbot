import { log } from "./logger";

export interface RetryOptions {
  operation: string;
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (error: unknown) => boolean;
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const initialDelayMs = Math.max(0, options.initialDelayMs ?? 250);
  const maxDelayMs = Math.max(initialDelayMs, options.maxDelayMs ?? 5_000);
  const shouldRetry = options.shouldRetry ?? (() => true);

  let attempt = 1;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maxAttempts || !shouldRetry(error)) throw error;

      const delayMs = Math.min(
        maxDelayMs,
        initialDelayMs * 2 ** (attempt - 1),
      );
      log("warn", "recoverable_operation_failed", {
        operation: options.operation,
        attempt,
        nextAttempt: attempt + 1,
        retryInMs: delayMs,
      });
      await sleep(delayMs);
      attempt += 1;
    }
  }
}

function sleep(delayMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}
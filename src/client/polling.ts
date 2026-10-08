/**
 * Generic poll-until-done helper for asynchronous Archivr work (capture jobs,
 * summaries). Sleep and clock are injectable so tests run instantly.
 */

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface PollTick {
  /** 1-based number of the poll that just completed. */
  attempt: number;
  elapsedMs: number;
}

export interface PollOptions<T> {
  /** True when `value` is a final state (stop polling). */
  isDone: (value: T) => boolean;
  /** First delay between polls. Default 1000. */
  intervalMs?: number;
  /** Multiplier applied to the delay after each poll. Default 1.5; use 1 for a fixed interval. */
  backoff?: number;
  /** Upper bound for the delay. Default 10000. */
  maxIntervalMs?: number;
  /** Give up after this long (measured by `now`). */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Called after every poll that is not final (progress notifications). Errors thrown here are ignored. */
  onTick?: (value: T, tick: PollTick) => void | Promise<void>;
  sleep?: Sleep;
  now?: () => number;
}

export type PollResult<T> =
  | { status: "done"; value: T; attempts: number }
  /** `last` is the most recent observed state, if any poll completed. */
  | { status: "timeout"; last: T | undefined; attempts: number }
  | { status: "aborted"; last: T | undefined; attempts: number };

/** Sleep that resolves early (without throwing) when `signal` aborts. */
export const defaultSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

/**
 * Call `fn` repeatedly until `isDone(value)`, the timeout elapses, or the signal aborts.
 * Errors thrown by `fn` propagate (unless the signal is aborted, which reports "aborted").
 */
export async function pollUntil<T>(
  fn: (signal: AbortSignal | undefined) => Promise<T>,
  options: PollOptions<T>,
): Promise<PollResult<T>> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const backoff = options.backoff ?? 1.5;
  const maxInterval = options.maxIntervalMs ?? 10_000;
  const { signal } = options;
  const start = now();
  let delay = options.intervalMs ?? 1000;
  let attempts = 0;
  let last: T | undefined;

  for (;;) {
    if (signal?.aborted) return { status: "aborted", last, attempts };
    let value: T;
    try {
      value = await fn(signal);
    } catch (error) {
      if (signal?.aborted) return { status: "aborted", last, attempts };
      throw error;
    }
    attempts += 1;
    last = value;
    if (options.isDone(value)) return { status: "done", value, attempts };

    const elapsed = now() - start;
    if (options.onTick !== undefined) {
      try {
        await options.onTick(value, { attempt: attempts, elapsedMs: elapsed });
      } catch {
        // Progress reporting is best effort.
      }
    }
    const remaining = options.timeoutMs - elapsed;
    if (remaining <= 0) return { status: "timeout", last, attempts };

    await sleep(Math.min(delay, remaining), signal);
    if (signal?.aborted) return { status: "aborted", last, attempts };
    delay = Math.min(delay * backoff, maxInterval);
  }
}

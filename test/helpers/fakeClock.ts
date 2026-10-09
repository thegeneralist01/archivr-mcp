import { pollHooks } from "../../src/tools/jobs";

export interface FakeClock {
  /** Total virtual milliseconds slept. */
  readonly elapsed: () => number;
  /** Make the next sleep abort `controller` (simulates the MCP request being cancelled). */
  abortOnSleep(controller: AbortController): void;
  restore(): void;
}

/** Install an instant sleep and a virtual clock into the tools' polling seam. */
export function installFakeClock(): FakeClock {
  let now = 0;
  let toAbort: AbortController | undefined;
  pollHooks.sleep = async (ms) => {
    now += ms;
    toAbort?.abort();
  };
  pollHooks.now = () => now;
  return {
    elapsed: () => now,
    abortOnSleep: (controller) => {
      toAbort = controller;
    },
    restore: () => {
      delete pollHooks.sleep;
      delete pollHooks.now;
    },
  };
}

/** A reply function that returns each reply in turn, repeating the last one. */
export function sequence<T>(replies: readonly T[]): () => T {
  let i = 0;
  return () => {
    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    if (reply === undefined) throw new Error("empty sequence");
    return reply;
  };
}

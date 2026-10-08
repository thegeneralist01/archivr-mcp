import { describe, expect, test } from "bun:test";
import { pollUntil } from "../../src/client/polling";

/** Fake clock: sleeping advances time instantly and records the requested delays. */
function fakeClock() {
  let t = 0;
  const delays: number[] = [];
  return {
    delays,
    now: () => t,
    sleep: async (ms: number) => {
      delays.push(ms);
      t += ms;
    },
  };
}

describe("pollUntil", () => {
  test("returns done as soon as isDone is true", async () => {
    const clock = fakeClock();
    let n = 0;
    const result = await pollUntil(async () => ++n, {
      isDone: (v) => v >= 3,
      intervalMs: 100,
      backoff: 1,
      timeoutMs: 10_000,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result).toEqual({ status: "done", value: 3, attempts: 3 });
    expect(clock.delays).toEqual([100, 100]);
  });

  test("backs off exponentially up to the cap", async () => {
    const clock = fakeClock();
    let n = 0;
    await pollUntil(async () => ++n, {
      isDone: (v) => v >= 6,
      intervalMs: 100,
      backoff: 2,
      maxIntervalMs: 500,
      timeoutMs: 100_000,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(clock.delays).toEqual([100, 200, 400, 500, 500]);
  });

  test("times out with the last observed value, polling once more at the deadline", async () => {
    const clock = fakeClock();
    const result = await pollUntil(async () => "running", {
      isDone: () => false,
      intervalMs: 400,
      backoff: 1,
      timeoutMs: 1000,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result.status).toBe("timeout");
    if (result.status === "timeout") expect(result.last).toBe("running");
    expect(clock.now()).toBe(1000); // never sleeps past the deadline
    expect(clock.delays).toEqual([400, 400, 200]);
  });

  test("calls onTick for each non-final poll and ignores its failures", async () => {
    const clock = fakeClock();
    const ticks: Array<[number, number]> = [];
    let n = 0;
    const result = await pollUntil(async () => ++n, {
      isDone: (v) => v === 3,
      intervalMs: 50,
      backoff: 1,
      timeoutMs: 10_000,
      sleep: clock.sleep,
      now: clock.now,
      onTick: (value, tick) => {
        ticks.push([value, tick.elapsedMs]);
        throw new Error("progress sink broke");
      },
    });
    expect(result.status).toBe("done");
    expect(ticks).toEqual([[1, 0], [2, 50]]);
  });

  test("aborts before the first poll", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const result = await pollUntil(async () => ++calls, { isDone: () => false, timeoutMs: 1000, signal: controller.signal });
    expect(result).toEqual({ status: "aborted", last: undefined, attempts: 0 });
    expect(calls).toBe(0);
  });

  test("aborts during the sleep and reports the last value", async () => {
    const controller = new AbortController();
    const result = await pollUntil(async () => "pending", {
      isDone: () => false,
      timeoutMs: 60_000,
      signal: controller.signal,
      sleep: async () => controller.abort(),
    });
    expect(result).toEqual({ status: "aborted", last: "pending", attempts: 1 });
  });

  test("a failing fn after abort reports aborted; otherwise the error propagates", async () => {
    const controller = new AbortController();
    const aborted = await pollUntil(
      async () => {
        controller.abort();
        throw new Error("fetch aborted");
      },
      { isDone: () => false, timeoutMs: 1000, signal: controller.signal },
    );
    expect(aborted.status).toBe("aborted");
    await expect(
      pollUntil(async () => { throw new Error("boom"); }, { isDone: () => false, timeoutMs: 1000 }),
    ).rejects.toThrow("boom");
  });

  test("the default sleep resolves early on abort", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const promise = pollUntil(async () => 1, { isDone: () => false, intervalMs: 30_000, timeoutMs: 60_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const result = await promise;
    expect(result.status).toBe("aborted");
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

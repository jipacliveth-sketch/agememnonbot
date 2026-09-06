import { describe, expect, it, vi } from "vitest";
import { RuntimeLease } from "../src/lib/runtime-lease";
import { withRetry } from "../src/lib/retry";
import type { RedisStorage } from "../src/bot/redis-storage";

describe("runtime resilience", () => {
  it("retries a transient operation with bounded backoff", async () => {
    vi.useFakeTimers();
    let attempts = 0;

    const result = withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("temporary failure");
        return "ok";
      },
      {
        operation: "test_operation",
        maxAttempts: 3,
        initialDelayMs: 10,
        maxDelayMs: 20,
      },
    );

    await vi.advanceTimersByTimeAsync(30);
    await expect(result).resolves.toBe("ok");
    expect(attempts).toBe(3);
    vi.useRealTimers();
  });

  it("does not retry a non-recoverable operation when filtered", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new Error("invalid configuration");
        },
        {
          operation: "test_non_recoverable",
          maxAttempts: 5,
          shouldRetry: () => false,
        },
      ),
    ).rejects.toThrow("invalid configuration");
    expect(attempts).toBe(1);
  });

  it("releases the singleton lease and reacts when renewal is lost", async () => {
    vi.useFakeTimers();
    const onLost = vi.fn();
    const storage = {
      acquireLease: vi.fn().mockResolvedValue(true),
      renewLease: vi.fn().mockResolvedValue(false),
      releaseLease: vi.fn().mockResolvedValue(true),
    } as unknown as RedisStorage<unknown>;
    const lease = new RuntimeLease(storage, onLost, "test:leader", 15);

    await lease.acquire();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(storage.renewLease).toHaveBeenCalled();
    expect(onLost).toHaveBeenCalledOnce();
    await lease.stop();
    expect(storage.releaseLease).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
import { randomUUID } from "node:crypto";
import { RedisStorage } from "../bot/redis-storage";
import { log, logError } from "./logger";

export class RuntimeLease {
  private readonly owner = randomUUID();
  private renewTimer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private acquired = false;

  constructor(
    private readonly storage: RedisStorage<unknown>,
    private readonly onLost: () => void,
    private readonly key = "agamemnon:runtime:leader",
    private readonly ttlSeconds = 60,
  ) {}

  async acquire() {
    const acquired = await this.storage.acquireLease(this.key, this.owner, this.ttlSeconds);
    if (!acquired) {
      throw new Error("Another Agamemnon process already owns the runtime lease.");
    }
    this.acquired = true;

    this.renewTimer = setInterval(() => {
      void this.storage
        .renewLease(this.key, this.owner, this.ttlSeconds)
        .then((renewed) => {
          if (renewed) return;
          log("error", "runtime_lease_lost", { key: this.key });
          this.stop();
          this.onLost();
        })
        .catch((error) => {
          logError("runtime_lease_renewal_failed", error, { key: this.key });
        });
    }, Math.max(5_000, Math.floor((this.ttlSeconds * 1_000) / 3)));
    this.renewTimer.unref();
    log("info", "runtime_lease_acquired", { key: this.key });
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.renewTimer = undefined;
    if (!this.acquired) return;
    try {
      await this.storage.releaseLease(this.key, this.owner);
      log("info", "runtime_lease_released", { key: this.key });
    } catch (error) {
      logError("runtime_lease_release_failed", error, { key: this.key });
    }
  }
}
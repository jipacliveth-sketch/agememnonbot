import { Database } from "../db/client";
import { runDepositWatcher } from "../services/deposit.service";
import { runReconciliation } from "../services/reconciliation.service";
import { log, logError } from "../lib/logger";
import { withRetry } from "../lib/retry";

export function startPlatformJobs(db: Database, options: { depositIntervalMs: number; reconciliationIntervalMs: number }) {
  let watcherBusy = false;
  let reconciliationBusy = false;
  let stopped = false;
  let watcherTask: Promise<void> | undefined;
  let reconciliationTask: Promise<void> | undefined;

  const runDepositCycle = () => {
    if (stopped || watcherBusy) return;
    watcherBusy = true;
    watcherTask = withRetry(() => runDepositWatcher(db), {
      operation: "deposit_watcher_cycle",
      maxAttempts: 3,
      initialDelayMs: 500,
      maxDelayMs: 5_000,
    })
      .catch((error) => logError("deposit_watcher_cycle_failed", error))
      .finally(() => {
        watcherBusy = false;
        watcherTask = undefined;
      });
    void watcherTask;
  };

  const runReconciliationCycle = () => {
    if (stopped || reconciliationBusy) return;
    reconciliationBusy = true;
    reconciliationTask = withRetry(() => runReconciliation(db), {
      operation: "reconciliation_cycle",
      maxAttempts: 3,
      initialDelayMs: 500,
      maxDelayMs: 5_000,
    })
      .then(() => undefined)
      .catch((error) => logError("reconciliation_cycle_failed", error))
      .finally(() => {
        reconciliationBusy = false;
        reconciliationTask = undefined;
      });
    void reconciliationTask;
  };

  const depositTimer = setInterval(async () => {
    runDepositCycle();
  }, options.depositIntervalMs);
  const reconciliationTimer = setInterval(async () => {
    runReconciliationCycle();
  }, options.reconciliationIntervalMs);

  depositTimer.unref();
  reconciliationTimer.unref();
  log("info", "platform_jobs_started", {
    depositIntervalMs: options.depositIntervalMs,
    reconciliationIntervalMs: options.reconciliationIntervalMs,
  });

  return async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(depositTimer);
    clearInterval(reconciliationTimer);
    await Promise.allSettled(
      [watcherTask, reconciliationTask].filter(
        (task): task is Promise<void> => Boolean(task),
      ),
    );
    log("info", "platform_jobs_stopped");
  };
}
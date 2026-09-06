import { readFileSync, writeFileSync } from "node:fs";

const MARKER_PATH = "/tmp/agamemnon-process-state.json";

type ProcessState = {
  pid: number;
  status: "running" | "stopped";
  startedAt: string;
  stoppedAt?: string;
};

export function markProcessStarted() {
  let previous: ProcessState | undefined;
  try {
    previous = JSON.parse(readFileSync(MARKER_PATH, "utf8")) as ProcessState;
  } catch {
    // A missing or unreadable marker is equivalent to a first start.
  }

  const restartedAfterUnexpectedExit = previous?.status === "running";
  const current: ProcessState = {
    pid: process.pid,
    status: "running",
    startedAt: new Date().toISOString(),
  };
  writeFileSync(MARKER_PATH, JSON.stringify(current), { mode: 0o600 });
  return restartedAfterUnexpectedExit;
}

export function markProcessStopped() {
  try {
    let current: ProcessState = {
      pid: process.pid,
      status: "stopped",
      startedAt: new Date().toISOString(),
    };
    try {
      const previous = JSON.parse(readFileSync(MARKER_PATH, "utf8")) as ProcessState;
      if (previous.pid === process.pid) current = previous;
    } catch {
      // Keep the fallback state when the running marker cannot be read.
    }
    current.status = "stopped";
    current.stoppedAt = new Date().toISOString();
    writeFileSync(MARKER_PATH, JSON.stringify(current), { mode: 0o600 });
  } catch {
    // Shutdown logging remains the source of truth if the marker cannot be written.
  }
}
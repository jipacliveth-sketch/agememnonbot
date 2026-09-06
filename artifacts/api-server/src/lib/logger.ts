type LogLevel = "info" | "warn" | "error";

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { value: String(error) };
}

export function log(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
) {
  const entry = {
    timestamp: new Date().toISOString(),
    service: "agamemnon-telegram-bot",
    level,
    event,
    ...fields,
  };

  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function logError(
  event: string,
  error: unknown,
  fields: Record<string, unknown> = {},
) {
  log("error", event, { ...fields, error: serializeError(error) });
}
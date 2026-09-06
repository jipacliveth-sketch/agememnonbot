import net from "node:net";
import tls from "node:tls";
import { URL } from "node:url";
import { withRetry } from "../lib/retry";

/**
 * Small dependency-free Redis storage adapter for grammY sessions. Each
 * command uses a short-lived connection, which keeps the adapter simple and
 * works with local Redis and managed Redis URLs without exposing credentials.
 */
export class RedisStorage<T> {
  private readonly host: string = "";
  private readonly port: number = 6379;
  private readonly username?: string;
  private readonly password?: string;
  private readonly database?: string;
  private readonly secure: boolean = false;

  private readonly restUrl?: string;
  private readonly restToken?: string;

  constructor(
    redisUrl: string | undefined,
    private readonly ttlSeconds = 60 * 60 * 24 * 30,
    rest?: { url: string; token: string },
  ) {
    if (rest) {
      this.restUrl = rest.url.replace(/\/+$/, "");
      this.restToken = rest.token;
      return;
    }

    if (!redisUrl) {
      throw new Error("Redis configuration is missing.");
    }

    const parsed = new URL(redisUrl);
    if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
      throw new Error("Redis URL must use redis:// or rediss://.");
    }
    this.host = parsed.hostname;
    this.port = Number(parsed.port || 6379);
    this.username = parsed.username ? decodeURIComponent(parsed.username) : undefined;
    this.password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
    this.database = parsed.pathname.length > 1 ? parsed.pathname.slice(1) : undefined;
    this.secure = parsed.protocol === "rediss:";
  }

  async read(key: string): Promise<T | undefined> {
    const raw = await this.command(["GET", key]);
    return raw ? JSON.parse(raw) as T : undefined;
  }

  async write(key: string, value: T): Promise<void> {
    await this.command(["SET", key, JSON.stringify(value), "EX", String(this.ttlSeconds)]);
  }

  async delete(key: string): Promise<void> {
    await this.command(["DEL", key]);
  }

  async ping(): Promise<void> {
    await this.command(["PING"]);
  }

  async acquireLease(key: string, owner: string, ttlSeconds: number): Promise<boolean> {
    return (await this.command(["SET", key, owner, "NX", "EX", String(ttlSeconds)])) === "OK";
  }

  async renewLease(key: string, owner: string, ttlSeconds: number): Promise<boolean> {
    return (await this.command(["SET", key, owner, "XX", "EX", String(ttlSeconds)])) === "OK";
  }

  async releaseLease(key: string, owner: string): Promise<boolean> {
    const result = await this.command([
      "EVAL",
      "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",
      "1",
      key,
      owner,
    ]);
    return result === "1";
  }

  private command(parts: string[]): Promise<string | null> {
    return withRetry(() => this.commandOnce(parts), {
      operation: `redis.${parts[0].toLowerCase()}`,
      maxAttempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 1_000,
    });
  }

  private commandOnce(parts: string[]): Promise<string | null> {
    if (this.restUrl && this.restToken) {
      return this.restCommand(parts);
    }

    const commands = [
      ...(this.password
        ? [this.username ? ["AUTH", this.username, this.password] : ["AUTH", this.password]]
        : []),
      ...(this.database ? [["SELECT", this.database]] : []),
      parts,
    ];
    return new Promise((resolve, reject) => {
      const socket = this.secure
        ? tls.connect({ host: this.host, port: this.port, servername: this.host })
        : net.createConnection({ host: this.host, port: this.port });
      let buffer = Buffer.alloc(0);
      let responses = 0;
      const expected = commands.length;
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error("Redis command timed out."));
      }, 2500);
      socket.on("connect", () => {
        socket.write(commands.map(encodeCommand).join(""));
      });
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (true) {
          const parsed = parseResponse(buffer);
          if (!parsed) break;
          buffer = parsed.rest as any;
          responses += 1;
          if (parsed.error) {
            clearTimeout(timeout);
            socket.destroy();
            reject(new Error(parsed.error));
            return;
          }
          if (responses === expected) {
            clearTimeout(timeout);
            socket.end();
            resolve(parsed.value);
            return;
          }
        }
      });
      socket.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  private async restCommand(parts: string[]): Promise<string | null> {
    const response = await fetch(
      `${this.restUrl}/${parts.map((part) => encodeURIComponent(part)).join("/")}`,
      {
        headers: {
          Authorization: `Bearer ${this.restToken}`,
        },
      },
    );

    const body = (await response.json()) as { result?: string | number | null; error?: string };
    if (!response.ok || body.error) {
      throw new Error(body.error ?? `Redis REST request failed with HTTP ${response.status}.`);
    }

    return body.result === undefined || body.result === null ? null : String(body.result);
  }
}

function encodeCommand(parts: string[]) {
  return `*${parts.length}\r\n${parts.map((part) => `$${Buffer.byteLength(part)}\r\n${part}\r\n`).join("")}`;
}

function parseResponse(buffer: Buffer): { value: string | null; rest: Buffer; error?: string } | null {
  const lineEnd = buffer.indexOf("\r\n");
  if (lineEnd < 0) return null;
  const prefix = String.fromCharCode(buffer[0]);
  if (prefix === "-" || prefix === "+" || prefix === ":") {
    const line = buffer.subarray(1, lineEnd).toString();
    return prefix === "-" ? { value: null, rest: buffer.subarray(lineEnd + 2), error: line } : { value: line, rest: buffer.subarray(lineEnd + 2) };
  }
  if (prefix === "$") {
    const length = Number(buffer.subarray(1, lineEnd).toString());
    if (length < 0) return { value: null, rest: buffer.subarray(lineEnd + 2) };
    const start = lineEnd + 2;
    if (buffer.length < start + length + 2) return null;
    return { value: buffer.subarray(start, start + length).toString(), rest: buffer.subarray(start + length + 2) };
  }
  return null;
}
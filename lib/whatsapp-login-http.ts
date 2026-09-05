import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

export function requireLoginDatabasePath(db: DatabaseSync, expected: string) {
  const main = db.prepare("PRAGMA database_list").all().find(row => row.name === "main");
  if (!main || typeof main.file !== "string" || !main.file || path.resolve(main.file) !== path.resolve(expected)) {
    throw new Error("Login database configuration mismatch.");
  }
}

export function sameOriginLoginRequest(request: Request, origin: string): boolean {
  return request.headers.get("origin") === origin
    && !["cross-site", "none"].includes(request.headers.get("sec-fetch-site") || "")
    && request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json";
}

export async function boundedLoginBody(request: Request, timeoutMs = 5000): Promise<Record<string, unknown>> {
  if (!request.body) throw new Error("Invalid request.");
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => { while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 4096) throw new Error("Invalid request.");
        parts.push(value);
      } })(),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Invalid request.")), timeoutMs); }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = Buffer.concat(parts);
  const result: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid request.");
  return result as Record<string, unknown>;
}

// The server's proxy chain has not been independently established as trusted.
// A conservative shared bucket cannot be bypassed with forged forwarding headers.
export const LOGIN_CLIENT_BUCKET = "management-site-global";

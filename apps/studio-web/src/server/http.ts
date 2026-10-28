import "server-only";
import { parseStrictJson } from "@studio/spec";

/** Expected user-facing failures carry safe messages, never provider payloads or credentials. */
export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public issues?: unknown) { super(message); }
}

/** Same-origin writes prevent a foreign page from sending a signed-in user's cookie to a mutation. */
export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  // Next may reconstruct request.url with localhost while the browser uses 127.0.0.1.
  // A configured deployment origin takes precedence; otherwise compare the actual HTTP host.
  const requestUrl = new URL(request.url);
  let expected: string;
  try { expected = new URL(process.env.STUDIO_PUBLIC_ORIGIN ?? `${requestUrl.protocol}//${request.headers.get("host") ?? requestUrl.host}`).origin; }
  catch { throw new HttpError(403, "ORIGIN_DENIED", "현재 사이트에서 다시 요청해 주세요."); }
  if (!origin || origin !== expected) throw new HttpError(403, "ORIGIN_DENIED", "현재 사이트에서 다시 요청해 주세요.");
}

/** Bound actual streamed bytes, not merely the untrusted Content-Length header. */
export async function readBody(request: Request, maxBytes = 2 * 1024 * 1024): Promise<Record<string, unknown>> {
  assertSameOrigin(request);
  // Parameters may accompany JSON; a prefix match must not admit application/jsonp or application/json-invalid.
  if (request.headers.get("content-type")?.split(';', 1)[0]?.trim().toLowerCase() !== "application/json") throw new HttpError(415, "JSON_REQUIRED", "JSON 형식의 요청이 필요합니다.");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "BODY_REQUIRED", "요청 내용을 확인해 주세요.");
  let total = 0; const chunks: Uint8Array[] = [];
  while (true) { const part = await reader.read(); if (part.done) break; total += part.value.byteLength; if (total > maxBytes) { await reader.cancel(); throw new HttpError(413, "BODY_TOO_LARGE", "요청 파일이 너무 큽니다."); } chunks.push(part.value); }
  const buffer = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  let value: unknown;
  try { value = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(buffer)); } catch { throw new HttpError(400, "JSON_INVALID", "JSON 형식 또는 중복 항목을 확인해 주세요."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "BODY_INVALID", "요청 객체가 필요합니다.");
  return value as Record<string, unknown>;
}

/** Route errors deliberately redact unexpected implementation and database details. */
export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return Response.json({ error: { code: error.code, message: error.message, issues: error.issues } }, { status: error.status, headers: { "Cache-Control": "no-store" } });
  return Response.json({ error: { code: "REQUEST_FAILED", message: "요청을 처리하지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요." } }, { status: 500, headers: { "Cache-Control": "no-store" } });
}

/** UUID validation keeps resource identifiers predictable before database queries. */
export function assertId(value: string) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new HttpError(404, "NOT_FOUND", "항목을 찾을 수 없습니다."); }

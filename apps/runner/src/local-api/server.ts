import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { extname, join, relative, isAbsolute, resolve } from 'node:path';
import { parseStrictJson } from '@studio/spec';
import { RunnerService, type StartRequest } from '../service.js';
import { RunnerError, objectValue, publicError, publicStatus, stringValue } from '../errors.js';

interface BrowserSession { csrf: string; expires: number }
interface ServerOptions { bearerToken: string; uiDirectory?: string }

/** Constant-time comparison prevents authenticated endpoint checks from leaking bearer prefixes. */
function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function body(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maxBytes) throw new RunnerError('REQUEST_TOO_LARGE', '요청 크기 제한을 초과했습니다.', 413);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new RunnerError('CONTENT_TYPE_REQUIRED', 'JSON 요청이 필요합니다.', 415);
  try { return objectValue(parseStrictJson((await body(request, 8 * 1024 * 1024)).toString('utf8'))); }
  catch (error) { if (error instanceof RunnerError) throw error; throw new RunnerError('INVALID_JSON', '요청 JSON이 올바르지 않습니다.'); }
}

function bindings(value: unknown): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, item] of Object.entries(objectValue(value ?? {}))) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(key)) throw new RunnerError('INVALID_BINDING', '모델 연결 별칭이 올바르지 않습니다.');
    result[key] = stringValue(item, '모델 연결 ID', 100);
  }
  return result;
}

/** Loopback serves only same-origin UI and authenticated daemon clients; no permissive CORS is installed. */
export function createLocalServer(service: RunnerService, options: ServerOptions) {
  const sessions = new Map<string, BrowserSession>();
  let origin = '';

  function reply(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(value));
  }

  function browserAuthenticated(request: IncomingMessage): boolean {
    const token = /(?:^|;\s*)studio_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie ?? '')?.[1];
    const session = token ? sessions.get(token) : undefined;
    if (!session || session.expires < Date.now()) return false;
    const csrf = request.headers['x-studio-csrf'];
    return request.headers['sec-fetch-site'] === 'same-origin' && typeof csrf === 'string' && sameSecret(csrf, session.csrf);
  }

  function authenticated(request: IncomingMessage): boolean {
    const authorization = request.headers.authorization;
    return authorization?.startsWith('Bearer ') && sameSecret(authorization.slice(7), options.bearerToken) || browserAuthenticated(request);
  }

  async function staticFile(pathname: string, response: ServerResponse): Promise<void> {
    if (!options.uiDirectory) throw new RunnerError('UI_NOT_INSTALLED', 'Runner 화면이 설치되지 않았습니다.', 503);
    let decoded: string;
    try { decoded = decodeURIComponent(pathname); } catch { throw new RunnerError('INVALID_PATH', '파일 경로가 올바르지 않습니다.'); }
    if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some((part) => part === '..' || part === '.')) throw new RunnerError('INVALID_PATH', '파일 경로가 올바르지 않습니다.');
    const root = await realpath(options.uiDirectory);
    const path = resolve(root, decoded === '/' ? 'index.html' : `.${decoded}`);
    const resolved = await realpath(path).catch(() => { throw new RunnerError('NOT_FOUND', '화면 파일을 찾을 수 없습니다.', 404); });
    const rel = relative(root, resolved);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new RunnerError('INVALID_PATH', '허용된 파일 경로가 아닙니다.', 403);
    const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
    response.writeHead(200, { 'content-type': mime[extname(resolved)] ?? 'application/octet-stream' });
    response.end(await readFile(resolved));
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('x-frame-options', 'DENY');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const expectedHost = new URL(origin).host;
    if (request.headers.host !== expectedHost || !['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) throw new RunnerError('HOST_DENIED', '허용되지 않은 로컬 연결입니다.', 403);
    const requestOrigin = request.headers.origin;
    if (requestOrigin !== undefined && requestOrigin !== origin) throw new RunnerError('ORIGIN_DENIED', '다른 웹사이트의 접근을 허용하지 않습니다.', 403);
    if (request.method === 'OPTIONS') throw new RunnerError('ORIGIN_DENIED', '교차 출처 요청을 허용하지 않습니다.', 403);
    const url = new URL(request.url ?? '/', origin);
    if (url.origin !== origin) throw new RunnerError('HOST_DENIED', '요청 주소가 올바르지 않습니다.', 403);

    // Same-origin JS can establish a browser session without putting a secret in URLs, logs, or process arguments.
    if (url.pathname === '/api/session' && request.method === 'POST') {
      if (requestOrigin !== origin || request.headers['sec-fetch-site'] !== 'same-origin' || request.headers['x-studio-client'] !== 'local-ui') throw new RunnerError('SESSION_DENIED', 'Runner 화면에서 다시 연결하세요.', 403);
      await jsonBody(request);
      for (const [key, session] of sessions) if (session.expires < Date.now()) sessions.delete(key);
      const previousToken = /(?:^|;\s*)studio_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie ?? '')?.[1];
      const previous = previousToken ? sessions.get(previousToken) : undefined;
      if (previous) { reply(response, 200, { csrf: previous.csrf }); return; }
      if (sessions.size >= 64) throw new RunnerError('SESSION_LIMIT', '열려 있는 Runner 화면이 너무 많습니다.', 429);
      const token = randomBytes(32).toString('hex'); const csrf = randomBytes(32).toString('hex');
      sessions.set(token, { csrf, expires: Date.now() + 8 * 60 * 60 * 1000 });
      response.setHeader('set-cookie', `studio_session=${token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=28800`);
      reply(response, 200, { csrf }); return;
    }
    if (!url.pathname.startsWith('/api/')) {
      if (request.method !== 'GET') throw new RunnerError('METHOD_NOT_ALLOWED', '허용되지 않은 요청입니다.', 405);
      await staticFile(url.pathname, response); return;
    }
    if (!authenticated(request)) throw new RunnerError('AUTH_REQUIRED', 'Runner 연결 인증이 필요합니다.', 401);
    const method = request.method;
    if (url.pathname === '/api/info' && method === 'GET') { reply(response, 200, { version: '0.1.0', capabilities: service.capabilities, secureStoreAvailable: service.credentials.available, runtimeVersion: process.version }); return; }
    if (url.pathname === '/api/packages' && method === 'GET') { reply(response, 200, service.store.listPackages()); return; }
    if (url.pathname === '/api/packages/import' && method === 'POST') {
      if (request.headers['content-type'] !== 'application/zip') throw new RunnerError('CONTENT_TYPE_REQUIRED', 'ZIP 파일이 필요합니다.', 415);
      reply(response, 201, await service.importPackage(await body(request, 128 * 1024 * 1024))); return;
    }
    const packageRoute = /^\/api\/packages\/([A-Za-z0-9_-]+)(?:\/(validate))?$/.exec(url.pathname);
    if (packageRoute) {
      const handle = packageRoute[1]!;
      if (!packageRoute[2] && method === 'GET') { reply(response, 200, await service.inspect(handle)); return; }
      if (packageRoute[2] === 'validate' && method === 'POST') { const value = await jsonBody(request); reply(response, 200, await service.validate(handle, bindings(value.modelBindings))); return; }
    }
    if (url.pathname === '/api/profiles' && method === 'GET') { reply(response, 200, service.listProfiles()); return; }
    if (url.pathname === '/api/profiles' && method === 'POST') { reply(response, 201, await service.createProfile(await jsonBody(request))); return; }
    if (url.pathname === '/api/runs' && method === 'GET') { reply(response, 200, service.store.listRuns()); return; }
    if (url.pathname === '/api/runs' && method === 'POST') {
      const value = await jsonBody(request);
      const start: StartRequest = { packageHandle: stringValue(value.packageHandle, '패키지 ID', 100), requestId: stringValue(value.requestId, '요청 ID', 128), inputs: value.inputs ?? {}, modelBindings: bindings(value.modelBindings) };
      reply(response, 202, await service.start(start)); return;
    }
    const artifactRoute = /^\/api\/runs\/([A-Za-z0-9_-]+)\/artifacts\/(file_[a-f0-9]{64})$/.exec(url.pathname);
    if (artifactRoute && method === 'GET') {
      const artifact = service.readArtifact(artifactRoute[1]!, artifactRoute[2]!);
      // Always download bytes as an attachment, including HTML or active content uploaded by a user.
      const encoded = encodeURIComponent(artifact.reference.filename).replace(/['()*]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="download"; filename*=UTF-8''${encoded}`, 'content-length': artifact.bytes.length }); response.end(artifact.bytes); return;
    }
    const uploadRoute = /^\/api\/runs\/([A-Za-z0-9_-]+)\/waits\/([A-Za-z0-9_-]+)\/files$/.exec(url.pathname);
    if (uploadRoute && method === 'POST') {
      if (request.headers.authorization !== undefined || requestOrigin !== origin || !browserAuthenticated(request)) throw new RunnerError('LOCAL_USER_REQUIRED', '파일 선택은 Studio Runner 화면에서 직접 제출하세요.', 403);
      if (request.headers['content-type'] !== 'application/octet-stream') throw new RunnerError('CONTENT_TYPE_REQUIRED', '선택한 파일의 바이트가 필요합니다.', 415);
      let filename: string;
      try { filename = decodeURIComponent(stringValue(request.headers['x-studio-filename'], '파일 이름', 2400)); } catch { throw new RunnerError('ARTIFACT_NAME_INVALID', '파일 이름이 올바르지 않습니다.'); }
      const uploadId = stringValue(request.headers['x-studio-upload-id'], '업로드 ID', 128); const mimeType = stringValue(request.headers['x-studio-mime-type'], '파일 형식', 120);
      const limit = service.fileUploadLimit(uploadRoute[1]!, uploadRoute[2]!);
      reply(response, 201, service.uploadWaitFile(uploadRoute[1]!, uploadRoute[2]!, uploadId, filename, mimeType, await body(request, limit))); return;
    }
    const responseRoute = /^\/api\/runs\/([A-Za-z0-9_-]+)\/waits\/([A-Za-z0-9_-]+)\/responses$/.exec(url.pathname);
    if (responseRoute && method === 'POST') {
      // A bridge bearer is never an identity for a human response, even when browser-like headers are supplied.
      if (request.headers.authorization !== undefined || requestOrigin !== origin || !browserAuthenticated(request)) throw new RunnerError('LOCAL_USER_REQUIRED', '사용자 응답은 Studio Runner 로컬 화면에서 직접 제출하세요.', 403);
      reply(response, 202, service.respondWait(responseRoute[1]!, responseRoute[2]!, await jsonBody(request))); return;
    }
    const runRoute = /^\/api\/runs\/([A-Za-z0-9_-]+)(?:\/(events|cancel|results))?$/.exec(url.pathname);
    if (runRoute) {
      const runId = runRoute[1]!;
      if (!runRoute[2] && method === 'GET') { reply(response, 200, service.status(runId)); return; }
      if (runRoute[2] === 'events' && method === 'GET') {
        const after = Number(url.searchParams.get('after') ?? '0');
        if (!Number.isSafeInteger(after) || after < 0) throw new RunnerError('INVALID_CURSOR', '이벤트 조회 위치가 올바르지 않습니다.');
        reply(response, 200, service.events(runId, after)); return;
      }
      if (runRoute[2] === 'results' && method === 'GET') { reply(response, 200, service.results(runId)); return; }
      if (runRoute[2] === 'cancel' && method === 'POST') { await jsonBody(request); reply(response, 200, service.cancel(runId)); return; }
    }
    throw new RunnerError('NOT_FOUND', '요청한 기능을 찾을 수 없습니다.', 404);
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (!response.headersSent && !response.destroyed) reply(response, publicStatus(error), { error: publicError(error) });
      else response.end();
    });
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;
  server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  return {
    server,
    async listen(port = 0): Promise<{ port: number; origin: string }> {
      await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolveListen(); }); });
      const address = server.address();
      if (!address || typeof address === 'string') throw new RunnerError('LISTEN_FAILED', 'Runner 주소를 만들지 못했습니다.');
      origin = `http://127.0.0.1:${address.port}`;
      return { port: address.port, origin };
    },
    async close(): Promise<void> { server.closeAllConnections(); await new Promise<void>((resolveClose) => server.close(() => resolveClose())); },
  };
}

import 'server-only';
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { parseStrictJson } from '@studio/spec';
import { authenticatedClient } from './auth';
import { assertId, HttpError } from './http';
import { publicCloudConfiguration } from '../config/public-cloud';
import type { Collection, Publication, PublicationKind, PublicationPage } from '../features/library/types';

const COLUMNS = 'id,kind,title,description,artifact_sha256,manifest_sha256,status,is_official,created_at';
const PAGE_SIZE = 24;
type Query = { kind: PublicationKind; collection: Collection; query: string; cursor: { at: string; id: string } | null; digest: string };
type Row = { id: string; kind: PublicationKind; title: string; description: string; artifact_sha256: string; manifest_sha256: string; status: string; is_official: boolean; created_at: string };

/** PostgreSQL timestamps retain microseconds; rounding a pagination key to JS milliseconds would skip rows. */
function cursorTime(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)$/.exec(value);
  if (!match || new Date(`${match[1]}Z`).toISOString().slice(0, 19) !== match[1]) throw new Error('invalid UTC timestamp');
  return `${match[1]}.${(match[2] ?? '').padEnd(6, '0')}Z`;
}

/** Public reads deliberately carry no staff cookie, so an owner's moderation view cannot leak into discovery. */
function discoveryClient() {
  const configured = publicCloudConfiguration();
  if (!configured) throw new HttpError(503, 'PUBLICATIONS_NOT_CONFIGURED', '공개 자료실 연결이 아직 설정되지 않았습니다. 게시된 항목을 확인할 수 없습니다.');
  const { url, key } = configured;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: (input, init) => fetch(input, { ...init, cache: 'no-store', signal: AbortSignal.timeout(10000) }) } });
}

/** Query parsing rejects duplicate/unknown fields and binds a cursor to its exact collection and title query. */
export function parseDiscoveryQuery(params: URLSearchParams): Query {
  for (const key of params.keys()) if (!['kind', 'collection', 'q', 'cursor'].includes(key) || params.getAll(key).length !== 1) throw new HttpError(400, 'DISCOVERY_QUERY_INVALID', '검색 조건을 확인해 주세요.');
  const kind = params.get('kind'); const collection = params.get('collection'); const query = (params.get('q') ?? '').trim();
  if ((kind !== 'project' && kind !== 'resource') || (collection !== 'official' && collection !== 'community') || query.length > 100 || /[\u0000-\u001f\u007f]/.test(query)) throw new HttpError(400, 'DISCOVERY_QUERY_INVALID', '자료 종류와 검색어(100자 이하)를 확인해 주세요.');
  const digest = createHash('sha256').update(JSON.stringify({ kind, collection, query })).digest('hex'); let cursor: Query['cursor'] = null;
  const encoded = params.get('cursor');
  if (encoded !== null) {
    try {
      if (!/^[A-Za-z0-9_-]{1,500}$/.test(encoded)) throw new Error('invalid encoding');
      const decoded = Buffer.from(encoded, 'base64url'); if (decoded.toString('base64url') !== encoded) throw new Error('noncanonical encoding');
      const value = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(decoded)) as Record<string, unknown>;
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'at,digest,id' || value.digest !== digest || typeof value.id !== 'string' || typeof value.at !== 'string' || cursorTime(value.at) !== value.at) throw new Error('invalid cursor');
      assertId(value.id); cursor = { at: value.at, id: value.id };
    } catch { throw new HttpError(400, 'DISCOVERY_CURSOR_INVALID', '검색 페이지가 유효하지 않습니다. 처음부터 다시 검색해 주세요.'); }
  }
  return { kind, collection, query, cursor, digest };
}

/** An explicit projection protects API output even if future database rows gain private fields. */
function publication(row: Row): Publication {
  return { id: row.id, kind: row.kind, title: row.title, description: row.description, artifactSha256: row.artifact_sha256, manifestSha256: row.manifest_sha256, official: row.is_official, publishedAt: row.created_at };
}

export async function listPublications(params: URLSearchParams): Promise<PublicationPage> {
  const query = parseDiscoveryQuery(params); const client = discoveryClient();
  const { data, error } = await client.rpc('search_public_releases', { p_kind: query.kind, p_official: query.collection === 'official', p_query: query.query, p_before_created_at: query.cursor?.at ?? null, p_before_id: query.cursor?.id ?? null, p_limit: PAGE_SIZE + 1 });
  if (error) throw new HttpError(503, 'PUBLICATIONS_UNAVAILABLE', '공개 자료실에 연결하지 못했습니다. 잠시 후 다시 확인해 주세요.');
  const rows = (data ?? []) as Row[]; const visible = rows.slice(0, PAGE_SIZE); const last = visible.at(-1);
  return { items: visible.map(publication), nextCursor: rows.length > PAGE_SIZE && last ? Buffer.from(JSON.stringify({ at: cursorTime(last.created_at), id: last.id, digest: query.digest })).toString('base64url') : null };
}

export async function getPublication(id: string, params: URLSearchParams): Promise<Publication> {
  assertId(id); const query = parseDiscoveryQuery(params);
  if (query.query || query.cursor) throw new HttpError(400, 'DISCOVERY_QUERY_INVALID', '상세 보기에는 검색 페이지 조건을 넣을 수 없습니다.');
  const { data, error } = await discoveryClient().from('public_releases').select(COLUMNS).eq('id', id).eq('status', 'published').eq('kind', query.kind).eq('is_official', query.collection === 'official').maybeSingle();
  if (error) throw new HttpError(503, 'PUBLICATIONS_UNAVAILABLE', '공개 항목을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  if (!data) throw new HttpError(404, 'PUBLICATION_NOT_FOUND', '게시된 항목을 찾을 수 없습니다. 공개가 중단되었거나 주소가 변경되었을 수 있습니다.');
  return publication(data as Row);
}

/** The server derives reporter identity from the verified user session; request bodies cannot select another user. */
export async function reportPublication(id: string, body: Record<string, unknown>): Promise<{ received: true; reportId: string }> {
  assertId(id);
  if (Object.keys(body).length !== 1 || typeof body.reason !== 'string') throw new HttpError(400, 'REPORT_INVALID', '신고 사유만 입력해 주세요.');
  const reason = body.reason.trim(); const length = Array.from(reason).length; if (length < 10 || length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reason)) throw new HttpError(400, 'REPORT_INVALID', '신고 사유를 10자 이상 4,000자 이하로 입력해 주세요.');
  const { client } = await authenticatedClient(); const { data, error } = await client.rpc('report_release', { p_release: id, p_reason: reason });
  if (error?.message === 'RELEASE_NOT_FOUND') throw new HttpError(404, 'PUBLICATION_NOT_FOUND', '이미 공개가 중단된 항목은 신고할 수 없습니다.');
  if (error) throw new HttpError(503, 'REPORT_FAILED', '신고를 접수하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  if (typeof data !== 'string') throw new HttpError(503, 'REPORT_FAILED', '신고 접수 결과를 확인하지 못했습니다.');
  return { received: true, reportId: data };
}

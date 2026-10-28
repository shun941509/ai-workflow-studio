import 'server-only';
import { authenticatedClient } from './auth';
import { authoringServiceClient } from './authoring-service';
import { copyPublication, parseImportReceipt, type PrivateCopyRepository } from './publication-copy';
import { HttpError, assertId } from './http';

let activeCopies = 0;
const MAX_COPIES = 2;

/** Database details are mapped to fixed messages; service metadata and provider error bodies never reach the browser. */
function copyRpcError(error: { message: string; code?: string }): HttpError {
  // Only a confirmed PostgreSQL application error is terminal. A transport exception with similar text is not proof.
  if (error.code === 'P0001') {
    if (/^(COPY_NOT_AVAILABLE|DELIVERY_NOT_AVAILABLE|COPY_RIGHTS_INVALID|COPY_RIGHTS_UNAVAILABLE)$/.test(error.message)) return new HttpError(409, 'COPY_NOT_AVAILABLE', '현재 이 공개 항목을 복사할 수 없습니다. 원본의 공개 상태와 복사·수정 권한을 확인해 주세요.');
    if (error.message === 'IMPORT_SOURCE_CHANGED') return new HttpError(409, 'COPY_SOURCE_CHANGED', '복사하는 동안 원본이나 이용 권한이 변경되었습니다.');
    if (error.message === 'IMPORT_STORAGE_MISMATCH') return new HttpError(409, 'COPY_STORAGE_INTEGRITY', '보관된 원본의 크기·검증 값이 고정한 파일과 다릅니다.');
    if (/^IMPORT_(PREPARATION|DEPENDENCY|RESOURCE|INPUT)_INVALID$/.test(error.message)) return new HttpError(409, 'COPY_SOURCE_INVALID', '원본의 자료·편집 정보를 현재 저장 규격으로 보존할 수 없습니다.');
    if (/^IMPORT_(NOT_AVAILABLE|OWNER_UNAVAILABLE)$/.test(error.message)) return new HttpError(409, 'COPY_IMPORT_UNAVAILABLE', '이 복사 요청이 만료되었거나 더 이상 사용할 수 없습니다.');
    if (/^(IMPORT_REQUEST_CONFLICT|IMPORT_PREPARATION_CONFLICT|COPY_RIGHTS_RETRY_CONFLICT)$/.test(error.message)) return new HttpError(409, 'COPY_CONFLICT', '기존 복사 요청과 원본 정보가 다릅니다. 최신 항목을 확인해 주세요.');
  }
  return new HttpError(503, 'COPY_RETRYABLE', '복사 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인해 주세요.');
}

/** Authentication establishes the owner; the only browser-selected fields are release ID and retry request ID. */
export async function copyConfiguredPublication(releaseId: string, requestId: string, request: Request) {
  assertId(releaseId); assertId(requestId);
  const { user } = await authenticatedClient();
  if (activeCopies >= MAX_COPIES) throw new HttpError(429, 'COPY_BUSY', '복사 요청이 많습니다. 잠시 후 다시 시도해 주세요.');
  activeCopies++;
  try {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(90000)]), client = authoringServiceClient(signal);
    const rpc = async (name: string, input: Record<string, unknown>) => {
      signal.throwIfAborted(); const { data, error } = await client.rpc(name, input); if (error) throw copyRpcError(error); return data;
    };
    const readObject = async (bucket: 'publication-releases' | 'authoring-imports', path: string) => {
      const { data, error } = await client.storage.from(bucket).download(path);
      if (error || !data) throw new HttpError(503, 'COPY_STORAGE_UNAVAILABLE', '복사할 원본 파일을 저장소에서 확인하지 못했습니다.');
      return new Response(data);
    };
    const repository: PrivateCopyRepository = {
      begin: (owner, requestId, release) => rpc('begin_private_import', { p_owner: owner, p_request: requestId, p_release: release }),
      resolveCopy: release => rpc('resolve_publication_copy', { p_release: release }),
      openPublicObject: path => readObject('publication-releases', path),
      openPrivateObject: path => readObject('authoring-imports', path),
      async putPrivateOnce(path, bytes) {
        const { error } = await client.storage.from('authoring-imports').upload(path, bytes, { contentType: 'application/zip', upsert: false, cacheControl: '0' });
        // A conflict is safe only because the next step reads and verifies the entire existing object.
        if (error && (!('statusCode' in error) || String(error.statusCode) !== '409')) throw new HttpError(503, 'COPY_STORAGE_UNCERTAIN', '원본 보관 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인해 주세요.');
      },
      stage: (id, preparation, preparationSha, bytes, sha) => rpc('stage_private_import', { p_import: id, p_preparation: preparation, p_preparation_sha: preparationSha, p_stored_bytes: bytes, p_stored_sha: sha }),
      commit: (id, preparationSha) => rpc('commit_private_import', { p_import: id, p_preparation_sha: preparationSha }),
      fail: (id, code) => rpc('fail_private_import', { p_import: id, p_code: code }),
    };
    return await copyPublication(repository, user.id, requestId, releaseId, signal);
  } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(503, 'COPY_RETRYABLE', '복사 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인해 주세요.'); }
  finally { activeCopies--; }
}

/** Status recovery is user-scoped and contains no privileged object paths or copied body data. */
export async function getConfiguredCopyStatus(requestId: string) {
  assertId(requestId); const { client } = await authenticatedClient();
  const { data, error } = await client.rpc('get_private_import_status', { p_request: requestId });
  if (error) throw copyRpcError(error);
  if (!data || typeof data !== 'object' || typeof data.importId !== 'string' || data.requestId !== requestId || typeof data.releaseId !== 'string' || !['staging', 'committed', 'failed'].includes(data.state)) throw new HttpError(409, 'COPY_STATE_INVALID', '저장된 복사 상태를 확인하지 못했습니다.');
  assertId(data.importId); assertId(data.releaseId);
  return { importId: data.importId as string, requestId, releaseId: data.releaseId as string, state: data.state as 'staging' | 'committed' | 'failed', receipt: data.state === 'committed' ? parseImportReceipt(data.receipt, data.importId) : null };
}

import { buildMaterialsPackage } from '@studio/package-kit';
import { loadPinnedResourceFiles } from '../../../../server/resources';
import { errorResponse, HttpError, readBody } from '../../../../server/http';
export const runtime = 'nodejs';

/** Materials packages reuse the exact owner/version/hash checks of workflow packages. */
export async function POST(request: Request) {
  try {
    const body = await readBody(request);
    if (body.host !== 'codex' && body.host !== 'claude-code' && body.host !== 'opencode') throw new HttpError(422, 'HOST_INVALID', '사용할 AI 도구를 선택해 주세요.');
    const materialized = await loadPinnedResourceFiles(body.refs, body.resourceBindings ?? {});
    if (!Object.keys(materialized.refs).length) throw new HttpError(422, 'RESOURCE_REQUIRED', '다운로드할 자료를 선택해 주세요.');
    const built = await buildMaterialsPackage({ host: body.host, refs: materialized.refs, resources: materialized.files, name: '내 도구 및 자료' });
    return new Response(new Uint8Array(built.bytes), { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="materials-${body.host}.zip"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) { return errorResponse(error); }
}

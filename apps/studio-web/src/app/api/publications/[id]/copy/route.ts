import { copyConfiguredPublication, getConfiguredCopyStatus } from '../../../../../server/publication-copy-configured';
import { assertId, errorResponse, HttpError, readBody } from '../../../../../server/http';
export const runtime = 'nodejs';

/** Copy accepts no owner, file, grant, trust key or storage path from the client. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params; assertId(id);
    if (new URL(request.url).search) throw new HttpError(400, 'COPY_REQUEST_INVALID', '복사 요청 주소를 확인해 주세요.');
    const body = await readBody(request, 1024);
    if (Object.keys(body).length !== 1 || typeof body.requestId !== 'string') throw new HttpError(400, 'COPY_REQUEST_INVALID', '복사 요청 ID만 전송해 주세요.');
    assertId(body.requestId);
    return Response.json({ receipt: await copyConfiguredPublication(id, body.requestId, request) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}

/** An interrupted browser may recover the same receipt without creating another copy. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params; assertId(id); const params = new URL(request.url).searchParams;
    if ([...params.keys()].length !== 1 || !params.has('requestId')) throw new HttpError(400, 'COPY_REQUEST_INVALID', '복사 요청 ID를 확인해 주세요.');
    const result = await getConfiguredCopyStatus(params.get('requestId')!);
    if (result.releaseId.toLowerCase() !== id.toLowerCase()) throw new HttpError(404, 'COPY_NOT_FOUND', '이 공개 항목의 복사 요청을 찾을 수 없습니다.');
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}

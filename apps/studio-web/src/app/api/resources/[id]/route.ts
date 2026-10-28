import { getResourceDetail } from '../../../../server/resource-library';
import { errorResponse, HttpError } from '../../../../server/http';
export const runtime = 'nodejs';

/** Open one explicit owned version; query fields cannot choose a storage path or a different owner. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params, params = new URL(request.url).searchParams;
    if ([...params.keys()].length !== 1 || params.getAll('versionId').length !== 1) throw new HttpError(400, 'RESOURCE_QUERY_INVALID', '열 자료의 고정 버전을 선택해 주세요.');
    return Response.json(await getResourceDetail(id, params.get('versionId')!), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}

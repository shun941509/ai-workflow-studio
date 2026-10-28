import { createResource } from "../../../server/resources";
import { listResourcePage } from '../../../server/resource-library';
import { errorResponse, HttpError, readBody } from "../../../server/http";
export const runtime = "nodejs";
/** Resource mutations use the authenticated server client and atomic version creation. */
export async function GET(request: Request) { try { const params = new URL(request.url).searchParams; if ([...params.keys()].some(key => key !== 'cursor') || params.getAll('cursor').length > 1) throw new HttpError(400, 'RESOURCE_QUERY_INVALID', '자료 목록 요청을 확인해 주세요.'); return Response.json(await listResourcePage(params.get('cursor')), { headers: { "Cache-Control": "no-store" } }); } catch (error) { return errorResponse(error); } }
export async function POST(request: Request) { try { return Response.json(await createResource(await readBody(request)), { status: 201 }); } catch (error) { return errorResponse(error); } }

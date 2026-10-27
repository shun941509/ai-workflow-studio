import { decideReview, getReview } from '../../../../../server/reviews';
import { errorResponse, readBody } from '../../../../../server/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** No scan/pass flags, publication action or service credential are accepted through this reviewer API. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) { try { return Response.json(await getReview((await params).id), { headers: { 'Cache-Control': 'no-store' } }); } catch (error) { return errorResponse(error); } }
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) { try { const body = await readBody(request, 20000); return Response.json(await decideReview((await params).id, body), { headers: { 'Cache-Control': 'no-store' } }); } catch (error) { return errorResponse(error); } }

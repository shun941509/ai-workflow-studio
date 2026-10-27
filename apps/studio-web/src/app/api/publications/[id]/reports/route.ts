import { reportPublication } from '../../../../../server/publications';
import { errorResponse, readBody } from '../../../../../server/http';
export const runtime = 'nodejs';
/** Existing same-origin, bounded JSON and verified Auth guards run before the report RPC. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { const body = await readBody(request, 20000); return Response.json(await reportPublication((await params).id, body), { status: 201, headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) { return errorResponse(error); }
}

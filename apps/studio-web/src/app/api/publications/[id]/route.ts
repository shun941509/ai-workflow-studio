import { getPublication } from '../../../../server/publications';
import { errorResponse } from '../../../../server/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Exact collection and published status are checked again instead of trusting a previously rendered card. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { return Response.json({ item: await getPublication((await params).id, new URL(request.url).searchParams) }, { headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) { return errorResponse(error); }
}

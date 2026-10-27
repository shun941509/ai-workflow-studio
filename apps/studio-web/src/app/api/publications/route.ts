import { listPublications } from '../../../server/publications';
import { errorResponse } from '../../../server/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Public metadata must be rechecked after suspension/revocation; neither success nor error responses are cached. */
export async function GET(request: Request) {
  try { return Response.json(await listPublications(new URL(request.url).searchParams), { headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) { return errorResponse(error); }
}

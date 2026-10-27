import { listReviews } from '../../../../server/reviews';
import { errorResponse } from '../../../../server/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Administrator review data is always authenticated, bounded and uncached. */
export async function GET(request: Request) { try { return Response.json(await listReviews(new URL(request.url).searchParams), { headers: { 'Cache-Control': 'no-store' } }); } catch (error) { return errorResponse(error); } }

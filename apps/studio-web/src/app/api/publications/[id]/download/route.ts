import { downloadConfiguredPublication } from '../../../../../server/publication-delivery';
import { errorResponse } from '../../../../../server/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Serve only the already-published, verified original ZIP; this route never signs, uploads or regenerates artifacts. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { return await downloadConfiguredPublication((await params).id, request); } catch (error) { return errorResponse(error); }
}

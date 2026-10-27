import { createRevision } from "../../../../../server/projects";
import { errorResponse, readBody } from "../../../../../server/http";
export const runtime = "nodejs";
/** Immutable revisions are created against a known optimistic draft version. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { try { return Response.json(await createRevision((await context.params).id, await readBody(request)), { status: 201 }); } catch (error) { return errorResponse(error); } }

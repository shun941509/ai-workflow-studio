import { deleteProject, getProject, saveProject } from "../../../../server/projects";
import { assertSameOrigin, errorResponse, readBody } from "../../../../server/http";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
/** All mutations validate origin and delegate ownership/version checks to one service layer. */
export async function GET(_request: Request, context: Context) { try { return Response.json(await getProject((await context.params).id), { headers: { "Cache-Control": "no-store" } }); } catch (error) { return errorResponse(error); } }
export async function PATCH(request: Request, context: Context) { try { return Response.json(await saveProject((await context.params).id, await readBody(request))); } catch (error) { return errorResponse(error); } }
export async function DELETE(request: Request, context: Context) { try { assertSameOrigin(request); await deleteProject((await context.params).id); return new Response(null, { status: 204 }); } catch (error) { return errorResponse(error); } }

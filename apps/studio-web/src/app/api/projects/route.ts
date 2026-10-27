import { createProject, listProjects } from "../../../server/projects";
import { errorResponse, readBody } from "../../../server/http";
export const runtime = "nodejs";
/** Private project endpoints require an authenticated RLS-scoped server client. */
export async function GET() { try { return Response.json({ projects: await listProjects() }, { headers: { "Cache-Control": "no-store" } }); } catch (error) { return errorResponse(error); } }
export async function POST(request: Request) { try { return Response.json(await createProject(await readBody(request)), { status: 201 }); } catch (error) { return errorResponse(error); } }

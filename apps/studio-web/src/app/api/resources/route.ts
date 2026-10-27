import { createResource, listResources } from "../../../server/resources";
import { errorResponse, readBody } from "../../../server/http";
export const runtime = "nodejs";
/** Resource mutations use the authenticated server client and atomic version creation. */
export async function GET() { try { return Response.json({ resources: await listResources() }, { headers: { "Cache-Control": "no-store" } }); } catch (error) { return errorResponse(error); } }
export async function POST(request: Request) { try { return Response.json(await createResource(await readBody(request)), { status: 201 }); } catch (error) { return errorResponse(error); } }

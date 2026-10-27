import "server-only";
import { validateWorkflowShape } from "@studio/spec";
import { canonicalDigest } from "@studio/package-kit";
import { authenticatedClient } from "./auth";
import { assertId, HttpError } from "./http";

/** A cloud draft may contain semantic errors while being edited, but its data shape must stay valid. */
export function draftPayload(body: Record<string, unknown>) {
  const result = validateWorkflowShape(body.workflow);
  if (!result.valid) throw new HttpError(422, "WORKFLOW_INVALID", "워크플로 형식을 확인해 주세요.", result.issues);
  if (!body.editor || typeof body.editor !== "object" || Array.isArray(body.editor)) throw new HttpError(422, "EDITOR_INVALID", "화면 배치 정보가 필요합니다.");
  return { workflow: result.value, editor: body.editor, name: result.value.name };
}

/** Ownership is enforced by both authenticated query scope and database RLS. */
export async function listProjects() {
  const { client, user } = await authenticatedClient();
  const { data, error } = await client.from("projects").select("id,name,created_at,updated_at").eq("owner_id", user.id).order("updated_at", { ascending: false }).limit(100);
  if (error) throw new HttpError(503, "STORAGE_UNAVAILABLE", "계정 저장소에 연결하지 못했습니다.");
  return data;
}

/** Creation is a database transaction so a project cannot be left without its initial draft. */
export async function createProject(body: Record<string, unknown>) {
  const payload = draftPayload(body); const { client } = await authenticatedClient();
  const { data, error } = await client.rpc("create_private_project", { p_name: payload.name, p_workflow: payload.workflow, p_editor: payload.editor });
  if (error) throw new HttpError(503, "SAVE_FAILED", "프로젝트를 계정에 저장하지 못했습니다.");
  return data;
}

/** Not-found includes inaccessible ids to avoid disclosing another user's project existence. */
export async function getProject(id: string) {
  assertId(id); const { client, user } = await authenticatedClient();
  const { data: project, error } = await client.from("projects").select("id,name,updated_at").eq("id", id).eq("owner_id", user.id).maybeSingle();
  if (error) throw new HttpError(503, "STORAGE_UNAVAILABLE", "계정 저장소에 연결하지 못했습니다.");
  if (!project) throw new HttpError(404, "NOT_FOUND", "프로젝트를 찾을 수 없습니다.");
  const { data: draft, error: draftError } = await client.from("project_drafts").select("project_id,version,workflow,editor,updated_at").eq("project_id", id).single();
  if (draftError) throw new HttpError(503, "DRAFT_UNAVAILABLE", "초안을 불러오지 못했습니다.");
  return { project, draft };
}

/** expectedVersion is compared in the write transaction, not in a race-prone read-then-write. */
export async function saveProject(id: string, body: Record<string, unknown>) {
  assertId(id); const payload = draftPayload(body);
  if (!Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) < 1) throw new HttpError(422, "VERSION_REQUIRED", "저장 버전이 필요합니다.");
  await getProject(id); const { client } = await authenticatedClient();
  const { data, error } = await client.rpc("save_private_draft", { p_project_id: id, p_expected_version: body.expectedVersion, p_name: payload.name, p_workflow: payload.workflow, p_editor: payload.editor });
  if (error?.code === "40001") throw new HttpError(409, "VERSION_CONFLICT", "다른 창에서 저장한 내용이 있습니다. 현재 초안을 보관하고 최신 내용을 다시 열어 주세요.");
  if (error) throw new HttpError(503, "SAVE_FAILED", "변경 내용을 저장하지 못했습니다.");
  return data;
}

/** Snapshot hashes are recomputed server-side from the exact draft selected by its version. */
export async function createRevision(id: string, body: Record<string, unknown>) {
  const { draft } = await getProject(id);
  if (body.expectedVersion !== draft.version) throw new HttpError(409, "VERSION_CONFLICT", "최신 저장 버전을 다시 확인해 주세요.");
  const { client } = await authenticatedClient();
  const { data, error } = await client.rpc("snapshot_private_project", { p_project_id: id, p_expected_version: draft.version, p_sha256: canonicalDigest(draft.workflow) });
  if (error?.code === "40001") throw new HttpError(409, "VERSION_CONFLICT", "저장 내용이 변경되었습니다. 다시 시도해 주세요.");
  if (error) throw new HttpError(503, "SNAPSHOT_FAILED", "프로젝트 버전을 만들지 못했습니다.");
  return data;
}

/** Deletion is scoped to the current owner; public distributions are a separate future lifecycle. */
export async function deleteProject(id: string) {
  await getProject(id); const { client, user } = await authenticatedClient();
  const { error } = await client.from("projects").delete().eq("id", id).eq("owner_id", user.id);
  if (error) throw new HttpError(503, "DELETE_FAILED", "프로젝트를 삭제하지 못했습니다.");
}

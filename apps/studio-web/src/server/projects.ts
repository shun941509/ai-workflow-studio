import "server-only";
import { validateWorkflowShape } from "@studio/spec";
import { canonicalDigest } from "@studio/package-kit";
import { authenticatedClient } from "./auth";
import { assertId, HttpError } from "./http";
import { loadPinnedResourceFiles } from './resources';
import { checkedEditorLayout } from './editor-layout';

/** A cloud draft may contain semantic errors while being edited, but its data shape must stay valid. */
export function draftPayload(body: Record<string, unknown>) {
  const result = validateWorkflowShape(body.workflow);
  if (!result.valid) throw new HttpError(422, "WORKFLOW_INVALID", "워크플로 형식을 확인해 주세요.", result.issues);
  return { workflow: result.value, editor: checkedEditorLayout(body.editor, result.value), name: result.value.name };
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
  const payload = draftPayload(body), materials = await loadPinnedResourceFiles(payload.workflow.resources, body.resourceBindings ?? {}); const { client } = await authenticatedClient();
  const { data, error } = await client.rpc("create_private_project_with_resources", { p_name: payload.name, p_workflow: payload.workflow, p_editor: payload.editor, p_bindings: materials.bindings });
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
  const [bindings, origin] = await Promise.all([
    client.from('private_resource_bindings').select('alias,version_id,reference').eq('project_id', id),
    client.from('project_origins').select('source,copied_at').eq('project_id', id).maybeSingle(),
  ]);
  if (bindings.error || origin.error) throw new HttpError(503, 'PROJECT_SOURCE_UNAVAILABLE', '프로젝트에 고정된 자료와 출처를 확인하지 못했습니다.');
  const fixed = bindings.data ?? [], versionIds = [...new Set(fixed.map(row => row.version_id))];
  const archiveRows: { version_id: string; reference: unknown; descriptor: { dependencies: Record<string, unknown> } }[] = [];
  // Keep the SQL URL and response size bounded even when a project carries hundreds of immutable pins.
  for (let start = 0; start < versionIds.length; start += 8) {
    const batch = versionIds.slice(start, start + 8);
    const archive = await client.from('resource_archive_versions').select('version_id,reference,descriptor').in('version_id', batch).limit(batch.length);
    if (archive.error) throw new HttpError(503, 'PROJECT_SOURCE_UNAVAILABLE', '자료 사이의 고정 연결을 확인하지 못했습니다.');
    archiveRows.push(...archive.data ?? []);
  }
  const resourceDependencies: Record<string, string[]> = Object.create(null);
  for (const row of fixed) {
    const source = archiveRows.find(item => item.version_id === row.version_id);
    if (source && (canonicalDigest(source.reference) !== canonicalDigest(row.reference) || !source.descriptor?.dependencies || typeof source.descriptor.dependencies !== 'object' || Array.isArray(source.descriptor.dependencies))) throw new HttpError(409, 'RESOURCE_DEPENDENCY_INVALID', '저장된 자료 의존성이 고정 버전과 다릅니다.');
    resourceDependencies[row.alias] = source ? Object.keys(source.descriptor.dependencies) : [];
    for (const alias of resourceDependencies[row.alias]!) if (!fixed.some(item => item.alias === alias && canonicalDigest(item.reference) === canonicalDigest(source!.descriptor.dependencies[alias]))) throw new HttpError(409, 'RESOURCE_DEPENDENCY_INVALID', '프로젝트 자료의 고정 의존성이 누락되었습니다.');
  }
  return { project, draft, resourceBindings: Object.fromEntries(fixed.map(row => [row.alias, row.version_id])), resourceDependencies, origin: origin.data };
}

/** expectedVersion is compared in the write transaction, not in a race-prone read-then-write. */
export async function saveProject(id: string, body: Record<string, unknown>) {
  assertId(id); const payload = draftPayload(body);
  if (!Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) < 1) throw new HttpError(422, "VERSION_REQUIRED", "저장 버전이 필요합니다.");
  const existing = await getProject(id); const { client } = await authenticatedClient();
  // Legacy callers may reuse the current exact pins; changed or newly attached archives need explicit bindings.
  const bindings = body.resourceBindings ?? Object.fromEntries(Object.entries(existing.resourceBindings).filter(([alias]) => canonicalDigest(existing.draft.workflow.resources?.[alias] ?? null) === canonicalDigest(payload.workflow.resources[alias] ?? null) && payload.workflow.resources[alias]));
  const materials = await loadPinnedResourceFiles(payload.workflow.resources, bindings);
  const { data, error } = await client.rpc("save_private_draft_with_resources", { p_project_id: id, p_expected_version: body.expectedVersion, p_name: payload.name, p_workflow: payload.workflow, p_editor: payload.editor, p_bindings: materials.bindings });
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

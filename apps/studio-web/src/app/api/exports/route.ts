import { buildPackage, type TargetHost } from "@studio/package-kit";
import { validateWorkflowShape } from "@studio/spec";
import { analyzeWorkflow } from "@studio/workflow-core";
import { errorResponse, HttpError, readBody } from "../../../server/http";
import { loadPinnedResourceFiles } from '../../../server/resources';
import { editorSupportIssues } from '../../../features/editor/editor-contract';
import { checkedEditorLayout } from '../../../server/editor-layout';
export const runtime = "nodejs";

/** A local draft is explicitly exported as a snapshot, never represented as cloud-saved or signed. */
export async function POST(request: Request) {
  try {
    const body = await readBody(request);
    const host = body.host;
    if (host !== "codex" && host !== "claude-code" && host !== "opencode") throw new HttpError(422, "HOST_INVALID", "사용할 AI 도구를 선택해 주세요.");
    const result = validateWorkflowShape(body.workflow);
    if (!result.valid) throw new HttpError(422, "WORKFLOW_INVALID", "워크플로 형식을 확인해 주세요.", result.issues);
    const editor = checkedEditorLayout(body.editor ?? {}, result.value);
    const issues = analyzeWorkflow(result.value);
    if (issues.some((issue) => issue.severity === "error")) throw new HttpError(422, "WORKFLOW_NOT_READY", "연결과 필수 설정을 먼저 확인해 주세요.", issues);
    const unsupported = editorSupportIssues(result.value);
    if (unsupported.length) throw new HttpError(422, 'CAPABILITY_NOT_READY', '현재 편집·다운로드 범위에 맞는 블록과 모드를 선택해 주세요.', unsupported);
    const materialized = await loadPinnedResourceFiles(result.value.resources, body.resourceBindings ?? {});
    const built = await buildPackage({ workflow: result.value, resources: materialized.files, host: host as TargetHost, editor });
    const file = new Uint8Array(built.bytes);
    return new Response(file, { headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="workflow-${host}.zip"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return errorResponse(error); }
}

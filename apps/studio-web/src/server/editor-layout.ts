import 'server-only';
import type { Workflow } from '@studio/spec';
import { validateImportedLayout } from '../features/editor/local-drafts';
import { HttpError } from './http';

/** Saving and exporting share the import contract: unknown metadata must never be silently discarded. */
export function checkedEditorLayout(value: unknown, workflow: Workflow) {
  try { return validateImportedLayout(value, workflow); }
  catch { throw new HttpError(422, 'EDITOR_INVALID', '화면 배치 정보를 확인해 주세요. 지원하지 않는 항목이나 잘못된 블록 위치가 있습니다.'); }
}

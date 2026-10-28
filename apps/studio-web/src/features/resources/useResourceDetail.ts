'use client';
import { useEffect, useState } from 'react';
import type { PrivateResourceDetail } from './types';
import { readResourceDetail } from './resource-client';

/** Key the visible body as well as the network request, so old text cannot flash during a new version selection. */
export function useResourceDetail(resourceId?: string, versionId?: string) {
  const key = resourceId && versionId ? `${resourceId}:${versionId}` : '';
  const [state, setState] = useState<{ key: string; detail?: PrivateResourceDetail; error?: string; loading: boolean }>({ key: '', loading: false });
  useEffect(() => {
    setState({ key, loading: Boolean(key) }); if (!resourceId || !versionId) return; const controller = new AbortController();
    void readResourceDetail(resourceId, versionId, controller.signal).then(detail => { if (!controller.signal.aborted) setState({ key, detail, loading: false }); }).catch(failure => { if (!controller.signal.aborted) setState({ key, loading: false, error: failure instanceof Error ? failure.message : '자료 버전을 읽지 못했습니다.' }); });
    return () => controller.abort();
  }, [resourceId, versionId, key]);
  return key && state.key === key ? { detail: state.detail, error: state.error, loading: state.loading } : { detail: undefined, error: undefined, loading: Boolean(key) };
}

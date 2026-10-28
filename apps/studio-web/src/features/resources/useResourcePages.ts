'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { readResourcePage } from './resource-client';
import type { PrivateResourceSummary } from './types';

/** One user action loads one bounded page. Request generations prevent refresh/unmount races and duplicate clicks. */
export function useResourcePages(configured: boolean) {
  const [items, setItems] = useState<PrivateResourceSummary[]>([]); const [ready, setReady] = useState(false); const [loading, setLoading] = useState(false); const [error, setError] = useState(''); const [nextCursor, setNextCursor] = useState<string | null>(null);
  const active = useRef<AbortController | undefined>(undefined); const generation = useRef(0); const busy = useRef(false); const cursor = useRef<string | null>(null); const seen = useRef(new Set<string>());
  const load = useCallback(async (reset: boolean) => {
    if (!configured) { active.current?.abort(); generation.current++; busy.current = false; cursor.current = null; setItems([]); setNextCursor(null); setLoading(false); setReady(true); setError('계정 저장 연결을 준비한 뒤 내 자료를 사용할 수 있습니다.'); return; }
    if (!reset && (busy.current || !cursor.current)) return;
    if (reset) { active.current?.abort(); generation.current++; seen.current.clear(); cursor.current = null; setNextCursor(null); setItems([]); setReady(false); }
    const revision = generation.current; const controller = new AbortController(); active.current = controller; busy.current = true; setLoading(true); setError(''); const requested = reset ? undefined : cursor.current!;
    try {
      const page = await readResourcePage(requested, controller.signal); if (controller.signal.aborted || revision !== generation.current) return;
      if (page.nextCursor && (seen.current.has(page.nextCursor) || page.nextCursor === requested)) throw new Error('같은 자료 페이지가 반복되어 다음 목록을 중단했습니다. 새로고침해 주세요.');
      if (requested) seen.current.add(requested);
      setItems(previous => [...new Map([...(reset ? [] : previous), ...page.resources].map(item => [item.id, item])).values()]); cursor.current = page.nextCursor; setNextCursor(page.nextCursor);
    } catch (failure) { if (!controller.signal.aborted && revision === generation.current) setError(failure instanceof Error ? failure.message : '자료 목록을 확인해 주세요.'); }
    finally { if (!controller.signal.aborted && revision === generation.current) { busy.current = false; setLoading(false); setReady(true); } }
  }, [configured]);
  useEffect(() => { void load(true); return () => { generation.current++; active.current?.abort(); busy.current = false; }; }, [load]);
  return { items, ready, loading, error, nextCursor, reload: () => load(true), loadMore: () => load(false) };
}

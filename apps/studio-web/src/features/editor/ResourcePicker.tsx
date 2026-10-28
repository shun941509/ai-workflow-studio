"use client";
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { FileText, Link2, RefreshCw, X } from 'lucide-react';
import { Button, Badge } from '@studio/ui';
import type { WorkflowNode, Workflow } from '@studio/spec';
import type { PrivateResourceDetail, PrivateResourceSummary } from '../resources/types';
import { useResourcePages } from '../resources/useResourcePages';
import { useResourceDetail } from '../resources/useResourceDetail';
import { readResourceDetail } from '../resources/resource-client';
import { ResourcePreview } from '../resources/ResourcePreview';

const labels: Record<string, string> = { instruction: '작업 지침', document: '문서', skill: 'Skill', mcp: 'MCP 연결' };

/** Attachment requires a fresh verified detail, including every source alias and its exact account version binding. */
export function ResourcePicker({ configured, node, resources, resourceBindings = {}, onAttach, onDetach }: { configured: boolean; node: WorkflowNode; resources: Workflow['resources']; resourceBindings?: Record<string, string>; onAttach: (detail: PrivateResourceDetail) => void; onDetach: (id: string) => void }) {
  const agentic = node.type === 'agent' && node.config.strategy === 'agentic_rag';
  const canAttach = ['ai', 'agent', 'resource'].includes(node.type) && !agentic; const pages = useResourcePages(configured && canAttach);
  const [message, setMessage] = useState(''); const [versions, setVersions] = useState<Record<string, string>>({}); const [preview, setPreview] = useState<{ id: string; versionId: string }>(); const [pending, setPending] = useState<string>();
  const opened = useResourceDetail(preview?.id, preview?.versionId); const generation = useRef(0); const request = useRef<AbortController | undefined>(undefined); const busy = useRef(false);
  useEffect(() => {
    // Strategy is part of the attachment boundary, including when the standalone component reuses the same node ID.
    setPending(undefined); setPreview(undefined); setMessage('');
    return () => { generation.current++; request.current?.abort(); busy.current = false; };
  }, [node.id, node.type, agentic]);
  const cancel = () => { generation.current++; request.current?.abort(); busy.current = false; setPending(undefined); };
  const attach = async (item: PrivateResourceSummary, versionId: string) => {
    if (!canAttach || busy.current) return; busy.current = true; const revision = ++generation.current; const controller = new AbortController(); request.current = controller; setPending(item.id); setMessage(''); setVersions(current => ({ ...current, [item.id]: versionId }));
    try { const detail = await readResourceDetail(item.id, versionId, controller.signal); if (controller.signal.aborted || revision !== generation.current) return; onAttach(detail); setPreview({ id: item.id, versionId }); setMessage('선택한 버전과 의존 자료를 연결했습니다.'); }
    catch (failure) { if (!controller.signal.aborted && revision === generation.current) setMessage(failure instanceof Error ? failure.message : '자료를 연결하지 못했습니다.'); }
    finally { if (revision === generation.current) { busy.current = false; setPending(undefined); } }
  };
  const attachedResources = node.type === 'resource' && resources[node.config.resource] ? [{ resource: node.config.resource, role: 'read' }] : node.attachments;
  const notice = !configured ? '계정 연결을 준비한 뒤 저장한 자료를 선택할 수 있습니다.' : message || pages.error;
  return <div className="resource-picker"><div className="resource-picker-heading"><h3>연결한 자료</h3><Button variant="ghost" onClick={() => { cancel(); setMessage(''); void pages.reload(); }} disabled={!configured || !canAttach || pages.loading} aria-label="자료 목록 새로고침"><RefreshCw size={14}/></Button></div>
    {attachedResources.length ? <ul className="attached-resources">{attachedResources.map(attachment => {
      const ref = resources[attachment.resource]; const versionId = resourceBindings[attachment.resource]; const item = pages.items.find(candidate => candidate.resource_versions.some(version => version.id === versionId) || !versionId && candidate.id === attachment.resource); const title = item?.name ?? attachment.resource;
      return <li key={attachment.resource}><FileText size={16}/><div><strong>{title}</strong><small>버전 {ref?.revision ?? '?'} 고정 · {attachment.role === 'instructions' ? '작업 지침' : attachment.role === 'read' ? '원문 읽기' : '참고 문서'}</small></div><button className="icon-button" onClick={() => { cancel(); onDetach(attachment.resource); }} aria-label={`${title} 연결 해제`}><X size={15}/></button></li>;
    })}</ul> : <p className="muted picker-empty">연결한 자료가 없습니다.</p>}
    {!canAttach ? <div className="inspector-info"><FileText size={18}/><p>{agentic ? '검색 에이전트는 직접 자료 첨부를 지원하지 않습니다. 입력·결과 탭에서 현재 실행의 키워드 색인 1~4개를 목록으로 연결하세요. 가져온 첨부가 있다면 직접 해제해야 합니다.' : 'AI 작업·단일 작업 에이전트 또는 자료 읽기 블록에서 자료를 연결하세요. 다른 블록은 입력·결과에서 자료 읽기의 결과를 참조할 수 있습니다.'}</p></div> : <>
      <div className="inspector-info"><Link2 size={17}/><p>{node.type === 'resource' ? '선택한 자료의 원문과 출처를 읽습니다. 자료 안의 값 위치는 기본 탭에서 지정할 수 있습니다.' : '작업 지침은 AI의 작업 방법으로, 문서는 참고할 내용으로 전달합니다.'} 선택한 버전과 고정 의존 자료가 ZIP에 포함됩니다.</p></div><h3>내 자료에서 선택</h3>
      {notice && <p className="form-error" role="status">{notice}</p>}
      {!pages.ready ? <p className="muted">자료를 불러오고 있습니다…</p> : !pages.items.length ? <p className="muted">계정에 저장한 자료가 없습니다.</p> : <div className="picker-available">{pages.items.map(item => {
        const versionId = versions[item.id] ?? item.resource_versions[0]?.id; if (!versionId) return null;
        const summary = item.resource_versions.find(version => version.id === versionId); const supported = ['instruction', 'document'].includes(item.kind);
        const attached = attachedResources.some(attachment => resourceBindings[attachment.resource] === versionId || !resourceBindings[attachment.resource] && attachment.resource === item.id && resources[attachment.resource]?.revision === summary?.revision);
        return <div className="picker-resource" key={item.id}><Badge>{labels[item.kind]}</Badge><strong>{item.name}</strong><p>{item.description || '설명이 없는 자료'}</p><div>
          <select aria-label={`${item.name} 자료 버전`} value={versionId} onChange={event => { cancel(); setMessage(''); setVersions(current => ({ ...current, [item.id]: event.target.value })); if (preview?.id === item.id) setPreview({ id: item.id, versionId: event.target.value }); }}>
            {!summary && <option value={versionId}>이전에 선택한 고정 버전</option>}{item.resource_versions.map(version => <option key={version.id} value={version.id}>버전 {version.revision}</option>)}
          </select><Button variant="secondary" disabled={!!pending} onClick={() => setPreview({ id: item.id, versionId })}>내용 확인</Button>
          <Button variant="secondary" disabled={!supported || attached || !!pending} onClick={() => void attach(item, versionId)}>{pending === item.id ? '확인 중…' : attached ? '연결됨' : '연결'}</Button>
        </div>{item.versionsTruncated && <small>최근 100개 버전만 표시합니다. 기존 고정 버전은 자동 교체하지 않습니다.</small>}{!supported && <small>이 자료는 원본 ZIP으로 활용할 수 있습니다. 편집기의 Skill 실행·MCP 연결은 지원하지 않습니다.</small>}</div>;
      })}</div>}
      {pages.nextCursor && <Button variant="secondary" disabled={pages.loading} onClick={() => void pages.loadMore()}>{pages.loading ? '불러오는 중…' : '자료 더 보기'}</Button>}
      {preview && <section aria-label="선택한 자료 내용"><div className="resource-picker-heading"><h3>선택한 버전 확인</h3><Button variant="ghost" aria-label="자료 미리보기 닫기" onClick={() => setPreview(undefined)}><X size={14}/></Button></div>{opened.loading ? <p role="status">자료를 확인하고 있습니다…</p> : opened.error ? <p className="form-error" role="alert">{opened.error}</p> : opened.detail ? <ResourcePreview key={opened.detail.version.id} detail={opened.detail}/> : null}</section>}
    </>}
    <Link href={configured ? '/resources' : '/account'} className="button button-secondary">{configured ? '자료 추가·관리' : '프로필·설정에서 확인'}</Link>
  </div>;
}

"use client";

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { FileText, Link2, RefreshCw, X } from 'lucide-react';
import { Button, Badge } from '@studio/ui';
import type { ResourceRef, WorkflowNode, Workflow } from '@studio/spec';
import type { PrivateTextResource } from '../resources/types';

/** The picker shows authenticated stored versions; it never invents resources when account setup is unavailable. */
export function ResourcePicker({ configured, node, resources, onAttach, onDetach }: { configured: boolean; node: WorkflowNode; resources: Workflow['resources']; onAttach: (reference: ResourceRef) => void; onDetach: (id: string) => void }) {
  const [items, setItems] = useState<PrivateTextResource[]>([]);
  const [message, setMessage] = useState(''); const [ready, setReady] = useState(false);
  const [refresh, setRefresh] = useState(0); const [versions, setVersions] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!configured) { setMessage('계정 연결을 준비한 뒤 저장한 자료를 선택할 수 있습니다.'); setReady(true); return; }
    const controller = new AbortController(); setReady(false);
    void (async () => { try {
      const response = await fetch('/api/resources', { cache: 'no-store', signal: controller.signal }); const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? '자료 목록을 불러오지 못했습니다.');
      if (!controller.signal.aborted) { setItems(body.resources); setMessage(''); }
    } catch (error) { if (!controller.signal.aborted) { setItems([]); setMessage(error instanceof Error ? error.message : '자료 연결을 확인해 주세요.'); } }
    finally { if (!controller.signal.aborted) setReady(true); } })();
    return () => controller.abort();
  }, [configured, refresh]);
  // A resource read pins config.resource instead of pretending to consume an AI attachment.
  const attachedResources = node.type === 'resource' && resources[node.config.resource] ? [{ resource: node.config.resource, role: 'read' }] : node.attachments;
  return <div className="resource-picker"><div className="resource-picker-heading"><h3>연결한 자료</h3><Button variant="ghost" onClick={() => setRefresh((value) => value + 1)} disabled={!configured || !ready} aria-label="자료 목록 새로고침"><RefreshCw size={14}/></Button></div>
    {attachedResources.length ? <ul className="attached-resources">{attachedResources.map((attachment) => { const ref = resources[attachment.resource]; const item = items.find((candidate) => candidate.id === attachment.resource); const version = item?.resource_versions.find((candidate) => candidate.revision === ref?.revision); return <li key={attachment.resource}><FileText size={16}/><div><strong>{version?.content.name ?? attachment.resource}</strong><small>버전 {ref?.revision ?? '?'} 고정 · {attachment.role === 'instructions' ? '작업 지침' : attachment.role === 'read' ? '원문 읽기' : '참고 문서'}</small></div><button className="icon-button" onClick={() => onDetach(attachment.resource)} aria-label={`${version?.content.name ?? attachment.resource} 연결 해제`}><X size={15}/></button></li>; })}</ul> : <p className="muted picker-empty">연결한 자료가 없습니다.</p>}
    {node.type !== 'ai' && node.type !== 'agent' && node.type !== 'resource' ? <div className="inspector-info"><FileText size={18}/><p>AI 작업·에이전트 또는 자료 읽기 블록에서 자료를 연결하세요. 다른 블록은 입력·결과에서 자료 읽기의 결과를 참조할 수 있습니다.</p></div> : <><div className="inspector-info"><Link2 size={17}/><p>{node.type === 'resource' ? '선택한 자료의 원문과 출처를 읽습니다. 자료 안의 값 위치는 기본 탭에서 지정할 수 있습니다.' : '작업 지침은 AI의 작업 방법으로, 문서는 참고할 내용으로 전달합니다.'} 선택한 버전의 실제 본문이 ZIP에 포함됩니다.</p></div><h3>내 자료에서 선택</h3>{message ? <p className="form-error" role="status">{message}</p> : !ready ? <p className="muted">자료를 불러오고 있습니다…</p> : !items.length ? <p className="muted">계정에 저장한 자료가 없습니다.</p> : <div className="picker-available">{items.map((item) => { const version = item.resource_versions.find((candidate) => candidate.revision === versions[item.id]) ?? item.resource_versions[0]; if (!version) return null; const pinned = resources[item.id]; const conflict = pinned && (pinned.revision !== version.revision || pinned.sha256 !== version.reference.sha256); const attached = attachedResources.some((attachment) => attachment.resource === item.id); return <div className="picker-resource" key={item.id}><Badge>{version.content.kind === 'instruction' ? '작업 지침' : '문서'}</Badge><strong>{version.content.name}</strong><p>{version.content.description || '설명이 없는 자료'}</p><div><select aria-label={`${item.name} 자료 버전`} value={version.revision} onChange={(event) => setVersions((current) => ({ ...current, [item.id]: Number(event.target.value) }))}>{item.resource_versions.map((candidate) => <option key={candidate.revision} value={candidate.revision}>버전 {candidate.revision}</option>)}</select><Button variant="secondary" disabled={Boolean(conflict) || attached} onClick={() => onAttach(version.reference)}>{attached ? '연결됨' : '연결'}</Button></div>{conflict ? <small>이 프로젝트는 버전 {pinned.revision}에 고정되어 있습니다.</small> : null}</div>; })}</div>}</>}
    <Link href={configured ? '/resources' : '/account'} className="button button-secondary">{configured ? '자료 추가·관리' : '프로필·설정에서 확인'}</Link>
  </div>;
}

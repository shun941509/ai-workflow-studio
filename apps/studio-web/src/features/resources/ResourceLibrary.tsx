"use client";

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Download, FileText, Plus, Search, X } from 'lucide-react';
import { Badge, Button, EmptyState, Field } from '@studio/ui';
import type { PrivateTextResource } from './types';

const labels: Record<string, string> = { instruction: '작업 지침', document: '문서', skill: 'Skill', mcp: 'MCP 연결' };

/** Stored version content is the source for preview and exact-version operational downloads. */
export function ResourceLibrary({ configured }: { configured: boolean }) {
  const [items, setItems] = useState<PrivateTextResource[]>([]);
  const [message, setMessage] = useState(''); const [ready, setReady] = useState(false);
  const [query, setQuery] = useState(''); const [kind, setKind] = useState('all');
  const [creating, setCreating] = useState(false); const [selected, setSelected] = useState<PrivateTextResource>();
  const [revision, setRevision] = useState<number>(); const [host, setHost] = useState('codex');
  const [name, setName] = useState(''); const [newKind, setNewKind] = useState('instruction');
  const [text, setText] = useState(''); const [description, setDescription] = useState(''); const [busy, setBusy] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    if (!configured) { setMessage('계정 저장 연결을 준비한 뒤 내 자료를 사용할 수 있습니다.'); setReady(true); return; }
    try {
      const response = await fetch('/api/resources', { cache: 'no-store', signal }); const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? '자료를 불러오지 못했습니다.');
      if (!signal?.aborted) { setItems(body.resources); setMessage(''); }
    } catch (error) { if (!signal?.aborted) setMessage(error instanceof Error ? error.message : '자료 저장소에 연결하지 못했습니다.'); }
    finally { if (!signal?.aborted) setReady(true); }
  }, [configured]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/resources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, kind: newKind, description, text }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error?.message ?? '저장하지 못했습니다.');
      setCreating(false); setName(''); setText(''); setDescription(''); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : '저장하지 못했습니다.'); }
    finally { setBusy(false); }
  };
  const version = selected?.resource_versions.find((candidate) => candidate.revision === revision) ?? selected?.resource_versions[0];
  const download = async () => {
    if (!selected || !version) return;
    setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/resources/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host, refs: { [selected.id]: version.reference } }) });
      if (!response.ok) { const body = await response.json(); throw new Error(body.error?.message ?? '자료 ZIP을 만들지 못했습니다.'); }
      const url = URL.createObjectURL(await response.blob()); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `materials-${host}.zip`; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(`버전 ${version.revision}의 실제 본문을 ZIP으로 내려받았습니다. 선택한 AI 도구에서 자료를 활용해 주세요.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : '자료 ZIP을 만들지 못했습니다.'); }
    finally { setBusy(false); }
  };
  const visible = items.filter((item) => (kind === 'all' || item.kind === kind) && `${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase()));
  return <>
    <div className="page-eyebrow">MY RESOURCES</div>
    <div className="page-heading"><div><h1>도구 및 자료</h1><p>AI에게 알려줄 작업 방법과 참고 자료를 모아두세요.</p></div><Button onClick={() => setCreating(true)} disabled={!configured} title={!configured ? '계정 서비스 연결이 필요합니다' : undefined}><Plus size={16}/>자료 추가</Button></div>
    <div className="library-toolbar"><div className="search-field"><Search size={17}/><input aria-label="자료 검색" placeholder="이름 또는 설명으로 검색" value={query} onChange={(event) => setQuery(event.target.value)}/></div><select aria-label="자료 종류" className="filter-select" value={kind} onChange={(event) => setKind(event.target.value)}><option value="all">모든 종류</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
    {message ? <div className="inline-notice" role="status"><p>{message}</p><Link href="/account">프로필·설정에서 확인 →</Link></div> : null}
    {!ready ? <p className="muted">자료를 불러오고 있습니다…</p> : visible.length ? <div className="resource-grid">{visible.map((item) => <button className="resource-card" key={item.id} onClick={() => { setSelected(item); setRevision(undefined); }}><span className="quick-icon violet"><FileText size={21}/></span><Badge>{labels[item.kind] ?? item.kind}</Badge><h3>{item.name}</h3><p>{item.description || '설명이 없는 자료'}</p><small>비공개 · 버전 {item.resource_versions[0]?.revision ?? '?'}</small></button>)}</div> : <EmptyState title={query || kind !== 'all' ? '일치하는 자료가 없습니다' : '아직 저장한 자료가 없습니다'} description="작업 지침과 텍스트 문서를 저장해 AI 블록에 연결하거나 자료 ZIP으로 활용할 수 있습니다. Skill 실행과 MCP 연결은 준비 중입니다."/>}
    {creating ? <section className="surface-card resource-form"><div className="modal-heading"><h2>새 자료 저장</h2><Button variant="ghost" onClick={() => setCreating(false)} aria-label="자료 추가 닫기"><X/></Button></div><form onSubmit={save}>
      <Field label="자료 이름" htmlFor="resource-name"><input id="resource-name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={120}/></Field>
      <Field label="종류" htmlFor="resource-kind"><select id="resource-kind" value={newKind} onChange={(event) => setNewKind(event.target.value)}><option value="instruction">작업 지침</option><option value="document">텍스트 문서</option></select></Field>
      <Field label="설명" htmlFor="resource-description"><input id="resource-description" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={2000}/></Field>
      <Field label="내용" htmlFor="resource-text" hint="256 KiB 이하의 비공개 자료로 저장됩니다. API 키나 비밀번호는 넣지 마세요."><textarea id="resource-text" value={text} onChange={(event) => setText(event.target.value)} rows={10} required maxLength={200000}/></Field>
      <Button type="submit" disabled={busy}>{busy ? '저장 중…' : '계정에 저장'}</Button>
    </form></section> : null}
    {selected && version ? <section className="surface-card resource-detail"><div className="modal-heading"><h2>{version.content.name}</h2><Button variant="ghost" onClick={() => setSelected(undefined)} aria-label="자료 내용 닫기"><X/></Button></div><Badge>{labels[version.content.kind]}</Badge><p>{version.content.description}</p>
      <div className="library-toolbar"><Field label="다운로드할 버전" htmlFor="download-version"><select id="download-version" value={version.revision} onChange={(event) => setRevision(Number(event.target.value))}>{selected.resource_versions.map((candidate) => <option key={candidate.revision} value={candidate.revision}>버전 {candidate.revision}</option>)}</select></Field><Field label="사용할 AI 도구" htmlFor="download-host"><select id="download-host" value={host} onChange={(event) => setHost(event.target.value)}><option value="codex">Codex</option><option value="claude-code">Claude Code</option><option value="opencode">OpenCode</option></select></Field><Button onClick={download} disabled={busy}><Download size={16}/>{busy ? 'ZIP 준비 중…' : '자료 ZIP 다운로드'}</Button></div>
      <p className="muted">선택한 버전의 지침·문서와 이용 조건을 포함합니다. 다운로드만으로 작업이 실행되지는 않습니다.</p><pre>{version.content.text}</pre>
    </section> : null}
  </>;
}

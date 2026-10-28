import { countLabels, fileReasons, generationLabels, presentWorkingContexts, usageLabels } from '../working-context-presentation';

/** Show only validated metadata. No raw manifest, request body, key, input text or download action enters this card. */
export function WorkingContextCard({ records, total, runId }: { records: unknown; total: unknown; runId: string }) {
  const view = presentWorkingContexts(records, total, runId);
  if (view.state === 'absent' || view.state === 'valid' && view.total === 0) return null;
  if (view.state === 'invalid') return <section className="panel" aria-label="업무 문맥 기록"><h2>업무 문맥 확인 필요</h2><p role="alert">문맥 기록 형식을 확인할 수 없어 자료 정보와 전달 상태를 표시하지 않습니다.</p></section>;
  return <section className="panel" aria-label="업무 문맥 기록" style={{ overflowWrap: 'anywhere' }}><h2>업무 문맥과 전달 상태</h2>
    <p>업무 정의와 선택 자료로 준비한 요청의 기록입니다. 원문과 입력 본문은 이 화면에 표시하지 않습니다.</p>
    <p className="field-note">준비·호출 의도 기록만으로 외부 서비스의 수신을 확인할 수 없습니다. 응답·사용량 확인도 내용의 정확성이나 업무 완료를 보장하지 않습니다.</p>
    {view.total > view.records.length && <p className="notice warning">전체 {view.total}건 중 {view.records.length}건을 표시합니다. 응답 크기와 건수 한도로 나머지 기록은 이 화면에 포함되지 않았습니다.</p>}
    {view.records.map(record => {
      const selected = record.manifest.assets.filter(asset => asset.selected), excluded = record.manifest.assets.length - selected.length;
      return <article key={record.id} aria-label={`문맥 ${record.manifest.nodeId}`}>
        <h3>{record.manifest.nodeId} · 문맥 준비 기록</h3><p>선택 자료 {selected.length}개 · 제외 자료 {excluded}개</p>
        <p><strong>{countLabels[record.countState]}</strong> · <strong>{generationLabels[record.generationState]}</strong></p>
        {(record.countState === 'unknown' || record.generationState === 'unknown') && <p className="notice warning">응답을 확인하지 못했습니다. 외부 작업이 없었다고 판단하거나 자동으로 다시 호출하지 않습니다.</p>}
        {record.errorCode && <p className="field-note">확인 코드: {record.errorCode}</p>}
        <details><summary>자료와 요청 근거 확인</summary>
          <p className="field-note">현재 범위는 업무에 고정하여 첨부한 자료입니다. 검색 문서나 다른 블록의 모든 입력을 나타내는 목록은 아닙니다. 해시와 출처의 서버 검사를 표시하며 외부 서비스의 별도 수신 증명은 아닙니다.</p>
          <dl><dt>요청 해시</dt><dd>{record.manifest.requestHash}</dd><dt>출처 기록 해시</dt><dd>{record.manifestHash}</dd><dt>요청 크기 / 한도</dt><dd>{record.manifest.requestBytes.toLocaleString()} / {record.manifest.maxBytes.toLocaleString()} bytes</dd><dt>연결된 모델</dt><dd>{record.manifest.provider} · {record.manifest.model}</dd><dt>준비 시각</dt><dd>{record.preparedAt}</dd><dt>최근 기록 시각</dt><dd>{record.updatedAt}</dd><dt>실행 시도</dt><dd>{record.manifest.attemptId}</dd></dl>
          {record.manifest.assets.map(asset => <details key={asset.alias}><summary>{asset.selected ? '선택' : '제외'} · {asset.alias} · 버전 {asset.revision}</summary>
            <p>{asset.purpose}</p><p className="field-note">{usageLabels[asset.usage]} · {asset.required ? '필수 자료' : '선택 자료'}{!asset.selected && ' · 이 요청의 문맥에 선택하지 않음'}</p>
            <dl><dt>자료 식별자</dt><dd>{asset.id}</dd><dt>고정 원본 해시</dt><dd>{asset.sha256}</dd></dl>
            <ul className="child-scopes" aria-label={`${asset.alias} 파일 목록`}>{asset.files.map(file => <li key={file.path}><div><strong>{file.path}</strong><p>{fileReasons[file.reason]}</p><small>{file.bytes.toLocaleString()} bytes · SHA-256 {file.sha256}</small></div></li>)}</ul>
          </details>)}
        </details>
      </article>;
    })}
  </section>;
}

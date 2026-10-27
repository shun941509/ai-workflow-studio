"use client";
import { useId } from 'react';
import type { WorkflowNode, JsonValue } from '@studio/spec';
import { Button, Field } from '@studio/ui';
import { StringListField } from './ValueForms';
type Step = Extract<WorkflowNode, { type: 'transform' }>['config']['steps'][number];
const operations = [['pick', '필드 선택'], ['omit', '필드 제외'], ['rename', '필드 이름 변경'], ['format', '문장 템플릿'], ['parse_json', 'JSON 문자 읽기'], ['stringify_json', 'JSON 문자 만들기'], ['map', '목록의 각 항목 변환']] as const;
const defaults: Record<string, Step['options']> = { pick: { keys: [] }, omit: { keys: [] }, rename: { mapping: {} }, format: { template: '{{}}' }, parse_json: {}, stringify_json: { indent: 2 }, map: { steps: [{ op: 'stringify_json' }] } };

/** Imported map options are arbitrary JSON until core validation; malformed children must not crash their repair UI. */
function renderableSteps(value: unknown): value is Step[] {
  return Array.isArray(value) && value.every((step) => step && typeof step === 'object' && typeof step.op === 'string' && operations.some(([op]) => op === step.op) && (step.options === undefined || step.options && typeof step.options === 'object' && !Array.isArray(step.options)));
}


/** Transformation steps expose only the registered finite DSL, including bounded nested array maps. */
export function TransformEditor({ steps, onChange, depth = 0 }: { steps: Step[]; onChange: (steps: Step[]) => void; depth?: number }) {
  const id = useId();
  return <section className="transform-editor">{steps.map((step, index) => {
    const options = step.options ?? {}; const patch = (value: Step) => onChange(steps.map((item, i) => i === index ? value : item));
    const option = (key: string, value: JsonValue) => patch({ ...step, options: { ...options, [key]: value } });
    return <fieldset className="step-card" key={index}><legend>변환 {index + 1}</legend><Field label={`변환 ${index + 1} 방식`} htmlFor={`${id}-${index}`}><select id={`${id}-${index}`} value={step.op} onChange={(event) => patch({ op: event.target.value as Step['op'], options: structuredClone(defaults[event.target.value]) })}>{operations.map(([op, title]) => <option key={op} value={op}>{title}</option>)}</select></Field>
      {step.op === 'pick' || step.op === 'omit' ? <><StringListField label={`변환 ${index + 1} 필드 이름`} value={(Array.isArray(options.keys) ? options.keys : []) as string[]} onChange={(keys) => option('keys', keys)}/>{step.op === 'pick' ? <Field label="선택한 필드가 없을 때" htmlFor={`${id}-${index}-missing`}><select id={`${id}-${index}-missing`} value={String(options.missing ?? 'error')} onChange={(event) => option('missing', event.target.value)}><option value="error">오류로 중단</option><option value="omit">없는 필드 제외</option></select></Field> : null}</> : null}
      {step.op === 'format' ? <Field label={`변환 ${index + 1} 문장 템플릿`} htmlFor={`${id}-${index}-template`} hint="전체 값: {{}} · 제목: {{/title}}. JavaScript 코드를 실행하지 않습니다."><textarea id={`${id}-${index}-template`} rows={3} value={String(options.template ?? '')} onChange={(event) => option('template', event.target.value)}/></Field> : null}
      {step.op === 'stringify_json' ? <Field label="들여쓰기 칸 수" htmlFor={`${id}-${index}-indent`}><input id={`${id}-${index}-indent`} type="number" min={0} max={8} value={Number(options.indent ?? 0)} onChange={(event) => option('indent', Number(event.target.value))}/></Field> : null}
      {step.op === 'rename' ? <RenameFields value={(options.mapping && typeof options.mapping === "object" && !Array.isArray(options.mapping) ? options.mapping : {}) as Record<string, string>} onChange={(value) => option('mapping', value)}/> : null}
      {step.op === 'map' ? !renderableSteps(options.steps) ? <><p className="form-error">목록 안의 변환 설정을 확인해야 합니다.</p><Button variant="secondary" onClick={() => option('steps', [{ op: 'stringify_json' }])}>목록 변환 설정 다시 만들기</Button></> : depth < 4 ? <TransformEditor steps={options.steps} depth={depth + 1} onChange={(value) => option('steps', value as unknown as JsonValue)}/> : <p className="inline-help">깊은 목록 변환은 고급 블록 JSON으로 편집하세요.</p> : null}
      <div className="row-actions"><Button variant="ghost" disabled={index === 0} onClick={() => { const next = [...steps]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; onChange(next); }}>위로</Button><Button variant="ghost" disabled={steps.length <= 1} onClick={() => onChange(steps.filter((_item, i) => i !== index))}>변환 삭제</Button></div>
    </fieldset>;
  })}<Button variant="secondary" disabled={steps.length >= 64} onClick={() => onChange([...steps, { op: 'stringify_json', options: { indent: 2 } }])}>변환 단계 추가</Button></section>;
}

/** Rename rows are applied as a mapping; duplicate targets are rejected by workflow execution rather than overwritten. */
function RenameFields({ value, onChange }: { value: Record<string, string>; onChange: (value: Record<string, string>) => void }) {
  const id = useId();
  return <div>{Object.entries(value).map(([from, to], index) => <div className="schema-property" key={index}><Field label="원래 필드" htmlFor={`${id}-${index}-from`}><input id={`${id}-${index}-from`} value={from} onChange={(event) => { if (Object.hasOwn(value, event.target.value) || ['__proto__', 'constructor', 'prototype'].includes(event.target.value)) return; const next = Object.fromEntries(Object.entries(value).map(([key, item]) => [key === from ? event.target.value : key, item])); onChange(next); }}/></Field><Field label="새 필드 이름" htmlFor={`${id}-${index}-to`}><input id={`${id}-${index}-to`} value={to} onChange={(event) => onChange({ ...value, [from]: event.target.value })}/></Field><Button variant="ghost" onClick={() => { const next = { ...value }; delete next[from]; onChange(next); }}>이름 변경 삭제</Button></div>)}<Button variant="secondary" onClick={() => { let name = 'field'; while (Object.hasOwn(value, name)) name += '_'; onChange({ ...value, [name]: `${name}_new` }); }}>이름 변경 추가</Button></div>;
}

"use client";
import { useId } from 'react';
import { Button, Field } from '@studio/ui';
import { validateExpression } from '@studio/workflow-core';
import { AdvancedJson, LiteralField } from './ValueForms';

export type Expression = { literal: unknown } | { var: string } | { op: string; args: Expression[] };
const operations = [['eq', '같음'], ['ne', '다름'], ['gt', '보다 큼'], ['gte', '이상'], ['lt', '보다 작음'], ['lte', '이하'], ['in', '목록에 포함'], ['exists', '값이 있음'], ['not', '반대'], ['and', '모두 일치'], ['or', '하나 이상 일치']] as const;

/** The visual tree serializes only the finite expression AST; no user text is executable code. */
export function ExpressionEditor({ label, value, onChange, depth = 0 }: { label: string; value: Expression; onChange: (value: Expression) => void; depth?: number }) {
  const id = useId(); const kind = 'var' in value ? 'var' : 'op' in value ? value.op : 'literal';
  const create = (type: string): Expression => type === 'var' ? { var: '/value' } : type === 'literal' ? { literal: true } : { op: type, args: type === 'exists' ? [{ var: '/value' }] : type === 'not' ? [{ literal: true }] : type === 'and' || type === 'or' ? [{ literal: true }, { literal: true }] : [{ var: '/value' }, { literal: '' }] };
  return <fieldset className="expression-form"><legend>{label}</legend><Field label={`${label} 방식`} htmlFor={id}><select id={id} value={kind} onChange={(event) => onChange(create(event.target.value))}><option value="literal">직접 정한 값</option><option value="var">입력 값 참조</option>{operations.map(([op, title]) => <option key={op} value={op}>{title}</option>)}</select></Field>
    {'literal' in value ? <LiteralField label={`${label} 비교 값`} value={value.literal} onChange={(literal) => onChange({ literal })}/> : 'var' in value ? <Field label={`${label} 값 위치`} htmlFor={`${id}-pointer`} hint="입력은 /value, 객체 안의 제목은 /value/title. 평가 통과 조건은 /scores/규칙이름을 사용합니다."><input id={`${id}-pointer`} value={value.var} placeholder="/value" onChange={(event) => onChange({ var: event.target.value })}/></Field> : depth < 6 ? <>{value.args.map((arg, index) => <ExpressionEditor key={index} label={`${label} ${index + 1}`} value={arg} depth={depth + 1} onChange={(next) => onChange({ ...value, args: value.args.map((item, i) => i === index ? next : item) })}/>)}{['and', 'or'].includes(value.op) ? <div className="row-actions"><Button variant="secondary" disabled={value.args.length >= 64} onClick={() => onChange({ ...value, args: [...value.args, { literal: true }] })}>조건 추가</Button><Button variant="ghost" disabled={value.args.length <= 2} onClick={() => onChange({ ...value, args: value.args.slice(0, -1) })}>마지막 조건 삭제</Button></div> : null}</> : <p className="muted">깊은 조건은 아래 전체 고급 설정에서 편집할 수 있습니다.</p>}
    {depth === 0 ? <AdvancedJson label={`${label} 고급 JSON`} value={value} check={validateExpression} onChange={(next) => onChange(next as Expression)}/> : null}
  </fieldset>;
}

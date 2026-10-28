import { FORBIDDEN_KEYS, getNodeDefinition, type Binding, type Workflow, type WorkflowNode } from '@studio/spec';

export interface BindingValueOption { pointer: string; label: string; description: string }

const option = (pointer: string, label: string, description = ''): BindingValueOption => ({ pointer, label, description });
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/** Only declared direct object fields are suggestions. We do not resolve refs, infer a union, or inspect sample/private values. */
export function schemaValueOptions(schema: unknown, base: string, label = '항목'): BindingValueOption[] {
  if (!record(schema) || schema.type !== 'object' || !record(schema.properties)) return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : []);
  return Object.entries(schema.properties).filter(([key, child]) => !FORBIDDEN_KEYS.has(key) && (child === true || record(child))).slice(0, 100).map(([key, child]) => {
    // JSON Pointer escapes each segment independently: a slash in a field name never becomes a nested path.
    const segment = key.replaceAll('~', '~0').replaceAll('/', '~1');
    const title = record(child) && typeof child.title === 'string' && child.title.trim() ? child.title : key || '(빈 이름)';
    return option(`${base}/${segment}`, `${label}: ${title}${required.has(key) ? '' : ' (선택 항목)'}`, required.has(key) ? '결과 형식에 정의된 필수 항목입니다.' : '값이 생략될 수 있습니다. 아래에서 값이 없을 때의 동작을 정하세요.');
  });
}

/** Paths match the implemented Runner envelopes. Registry optional text/files keys alone are not proof that a handler returns them. */
export function nodeValueOptions(node: WorkflowNode, workflow: Workflow): BindingValueOption[] {
  const definition = getNodeDefinition(node.type, node.typeVersion);
  if (!definition || !Array.isArray(definition.outputSchema.required) || !definition.outputSchema.required.includes('data')) return [];
  const options = [option('/data', '전체 결과', '이 블록이 만든 데이터 전체를 전달합니다.')];
  const fields = (schema: unknown, base = '/data', label?: string) => options.push(...schemaValueOptions(schema, base, label));
  switch (node.type) {
    // Child results are the child's final envelope, not an additional /result wrapper.
    case 'subworkflow': if (node.config.flowRef.kind === 'local') fields(workflow.subworkflows[node.config.flowRef.flowId]?.outputs); break;
    case 'input': fields(workflow.inputs, '/data', '입력 항목'); break;
    case 'form': fields(node.config.mode === 'initial' ? workflow.inputs : node.config.schema, '/data', '답변 항목'); break;
    case 'ai':
      if (node.config.responseFormat.mode === 'text') options[0] = option('/data', 'AI가 작성한 텍스트 (전체 결과)');
      else fields(node.config.responseFormat.schema);
      break;
    case 'agent':
      // Other strategies have different lifecycle envelopes; do not present task-result paths as universal Agent support.
      if (node.config.strategy === 'task') { options.push(option('/data/result', '에이전트 결과'), option('/data/stopReason', '에이전트 종료 이유')); fields(node.config.resultSchema, '/data/result', '에이전트 결과 항목'); }
      if (node.config.strategy === 'agentic_rag') {
        options[0] = option('/data', '답변 상태·결과·인용 전체', 'JSON 최종 결과에 전체를 연결하면 답변 유보 상태와 근거를 함께 보존합니다.');
        options.push(option('/data/status', '답변 상태', 'answered, insufficient_evidence 또는 conflicting_evidence입니다.'), option('/data/result', '에이전트 답변 (유보 시 null)', '답변 유보·충돌이면 null입니다. 필수 문자열 결과로 바로 연결하지 마세요.'), option('/data/citations', '답변의 인용 근거'), option('/data/stopReason', '에이전트 종료 이유'), option('/data/usage', '검색 단계·문맥 사용량'));
        // Even required schema fields are absent when the enclosing result is null; do not advertise them as unconditional values.
        options.push(...schemaValueOptions(node.config.resultSchema, '/data/result', '답변 항목').map(item => ({ ...item, label: `${item.label} (답변이 있을 때)`, description: '답변 유보·충돌이면 이 항목이 없습니다. 상태를 분기하거나 누락 시 동작을 지정하세요.' })));
      }
      break;
    case 'classify': options.push(option('/data/label', '분류 이름'), option('/data/reason', '분류 이유')); break;
    case 'output': fields(workflow.outputs); break;
    case 'transform': fields(node.config.resultSchema); break;
    case 'condition': options.push(option('/data/matched', '조건 일치 여부'), option('/data/value', '검사한 원래 값')); break;
    case 'evaluate': options.push(option('/data/passed', '평가 통과 여부'), option('/data/scores', '평가 점수'), option('/data/evidence', '평가 근거')); break;
    case 'review':
      options.push(option('/data/decision', '사용자 검토 결정'), option('/data/feedback', '사용자가 작성한 답변'));
      fields(node.config.responseSchema, '/data/feedback', '검토 답변 항목'); break;
    case 'file_input':
      options[0] = option('/data', '선택한 파일 목록 (전체 결과)', '문서 색인을 만들 때 파일 목록 전체를 연결하세요.');
      options.push(option('/data/0', '첫 번째 파일', '문서 읽기·파일 복사처럼 파일 하나를 받는 입력에 연결하세요. 파일이 없으면 아래의 누락 규칙을 따릅니다.')); break;
    case 'file_output': options[0] = option('/data', '만든 파일 (전체 결과)', '파일 내용이 아닌 관리되는 파일 참조입니다.'); break;
    case 'document_extract':
      if (node.config.mode === 'text') options.push(option('/data/text', '원문 텍스트'), option('/data/locations', '원문 위치 근거', '읽은 파일과 UTF-8 바이트 범위, 원문 해시를 포함합니다.'));
      break;
    case 'knowledge': options[0] = option('/data', '검색용 색인 (전체 결과)', '검색 블록의 검색용 색인 입력으로 연결하세요.'); break;
    case 'retrieval':
      if (['keyword', 'vector', 'hybrid'].includes(node.config.mode)) options.push(option('/data/context', '검색 문맥', '찾은 문서 조각을 문맥 한도 안에서 합친 텍스트입니다.'), option('/data/citations', '인용 근거'), option('/data/candidates', '찾은 문서 조각'), option('/data/index', '사용한 검색용 색인'));
      break;
    case 'memory':
      options.push(option('/data/value', '기억 값', '기억이 없거나 삭제된 경우 null입니다. 기억 존재 여부를 함께 확인할 수 있습니다.'), option('/data/found', '기억 존재 여부'), option('/data/version', '기억 버전')); break;
    // Resource/guardrail/merge/error data depends on explicit input; no shape is guessed from a block's name.
    default: break;
  }
  return options;
}

/** Suggestions never mutate a Binding. Changing source blocks preserves custom pointers until the user chooses a value. */
export function bindingValueOptions(binding: Binding, workflow: Workflow): BindingValueOption[] {
  if (binding.from === 'node') {
    const source = workflow.nodes.find(node => node.id === binding.nodeId);
    return source ? nodeValueOptions(source, workflow) : [];
  }
  if (binding.from === 'workflowInput') return [option('', '실행 입력 전체'), ...schemaValueOptions(workflow.inputs, '', '입력 항목')];
  if (binding.from === 'resource') return [option('/data', '자료 전체', '고정한 자료의 내용입니다. 세부 구조는 자료의 형식에 따라 다릅니다.')];
  if (binding.from === 'error') return [option('', '오류 정보 전체'), option('/code', '오류 코드'), option('/message', '오류 설명'), option('/nodeId', '오류가 발생한 블록 ID')];
  return [];
}

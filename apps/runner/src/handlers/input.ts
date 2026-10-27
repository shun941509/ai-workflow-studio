import type { NodeOutput } from '@studio/workflow-core';

/** The entry node exposes validated flow input without stringifying or coercing it. */
export function executeInput(input: unknown): NodeOutput { return { data: input }; }

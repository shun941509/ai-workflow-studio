import { PackageError } from '@studio/package-kit';
import { ContractError, CoreOperationError } from '@studio/workflow-core';
import { StrictJsonError } from '@studio/spec';

/** Public errors carry stable codes, never raw provider bodies or credentials. */
export class RunnerError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = 'RunnerError';
  }
}

/** Deliberately redact unknown exceptions at transport boundaries. */
export function publicError(error: unknown): { code: string; message: string } {
  return error instanceof RunnerError || error instanceof PackageError || error instanceof ContractError || error instanceof CoreOperationError || error instanceof StrictJsonError
    ? { code: error.code, message: error.message }
    : { code: 'INTERNAL_ERROR', message: '작업을 완료하지 못했습니다. Runner 상태를 확인하세요.' };
}

/** Only our validation classes are client errors; unknown infrastructure failures stay redacted server errors. */
export function publicStatus(error: unknown): number {
  return error instanceof RunnerError ? error.status : error instanceof PackageError || error instanceof ContractError || error instanceof CoreOperationError || error instanceof StrictJsonError ? 400 : 500;
}

/** Only ordinary objects are accepted at HTTP/MCP boundaries. */
export function objectValue(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RunnerError('INVALID_REQUEST', '객체 형식의 요청이 필요합니다.');
  }
  return value as Record<string, unknown>;
}

/** Validate bounded, nonempty strings before using them as identifiers or labels. */
export function stringValue(value: unknown, field: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new RunnerError('INVALID_REQUEST', `${field} 값이 올바르지 않습니다.`);
  }
  return value;
}


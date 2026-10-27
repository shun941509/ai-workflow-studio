import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { canonicalDigest } from '@studio/package-kit';
import { assertJsonData, createSchemaValidator, parseStrictJson, type FileRef } from '@studio/spec';
import fileRefSchema from '../../../../packages/spec/schemas/file-ref.schema.json' with { type: 'json' };
import { RunnerError } from '../errors.js';
import { validateArtifactFilename } from '@studio/workflow-core';
export { validateArtifactFilename } from '@studio/workflow-core';

const MAX_FILE_BYTES = 128 * 1024 * 1024;
const validRef = createSchemaValidator().compile<FileRef>(fileRefSchema);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fail = (code: string, message: string): never => { throw new RunnerError(code, message); };
export interface ArtifactLimits { maxBytesPerFile: number; maxBytesPerRun: number; maxFilesPerRun: number }
interface StoredArtifact { schemaVersion: 1; runId: string; operationId: string; requestHash: string; reference: FileRef }
export interface ArtifactWrite { operationId: string; filename: string; mimeType: string; bytes: Uint8Array }

function identity(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) fail('ARTIFACT_SCOPE_INVALID', '파일 작업의 실행·요청 식별자가 올바르지 않습니다.');
  return value;
}

/** Reject reparse-point ancestors. Worker processes must not receive this private store as a writable mount. */
function directory(path: string, create = false): void {
  const absolute = resolve(path); const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) {
      if (!create) fail('ARTIFACT_NOT_FOUND', '파일 저장 위치를 찾을 수 없습니다.');
      try { mkdirSync(current, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || relative(current, realpathSync(current)) !== '') fail('ARTIFACT_PATH_UNSAFE', '파일 저장 경로에 링크를 사용할 수 없습니다.');
  }
}

/** Read through one bounded file descriptor and reject hard links and replacement during open. */
function readBounded(path: string, limit: number): Uint8Array {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) fail('ARTIFACT_PATH_UNSAFE', '파일의 종류·연결·크기 검사를 통과하지 못했습니다.');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = fstatSync(fd);
    if (!actual.isFile() || actual.nlink !== 1 || actual.dev !== before.dev || actual.ino !== before.ino || actual.size !== before.size) fail('ARTIFACT_PATH_UNSAFE', '검사 중 파일이 변경되었습니다.');
    // One extra byte detects growth without letting readFile allocate an attacker-controlled amount.
    const buffer = Buffer.alloc(actual.size + 1); let count = 0;
    while (count < buffer.length) {
      const read = readSync(fd, buffer, count, buffer.length - count, null);
      if (!read) break; count += read;
    }
    if (count > limit || count !== actual.size) fail('ARTIFACT_INTEGRITY', '파일 크기가 저장 기록과 다릅니다.');
    return buffer.subarray(0, count);
  } finally { closeSync(fd); }
}

/** Immutable, run-scoped storage for one leased Runner process. All quota decisions and commits are synchronous. */
export class ArtifactStore {
  readonly root: string;
  readonly limits: Readonly<ArtifactLimits>;
  constructor(root: string, limits: Partial<ArtifactLimits> = {}) {
    this.root = resolve(root);
    this.limits = Object.freeze({ maxBytesPerFile: 16 * 1024 * 1024, maxBytesPerRun: 128 * 1024 * 1024, maxFilesPerRun: 100, ...limits });
    for (const limit of Object.values(this.limits)) if (!Number.isSafeInteger(limit) || limit < 1) fail('ARTIFACT_LIMIT_INVALID', '파일 저장 한도가 올바르지 않습니다.');
    if (this.limits.maxBytesPerFile > MAX_FILE_BYTES || this.limits.maxFilesPerRun > 1000 || this.limits.maxBytesPerRun > 512 * 1024 * 1024) fail('ARTIFACT_LIMIT_INVALID', '허용된 파일 저장 상한을 초과했습니다.');
    directory(this.root, true);
  }

  private runDirectory(runId: string, create = false): string {
    identity(runId); directory(this.root);
    const result = join(this.root, `run_${hash(Buffer.from(runId))}`);
    directory(result, create); return result;
  }

  private stored(runId: string, fileId: string): StoredArtifact {
    if (typeof fileId !== 'string' || !/^file_[a-f0-9]{64}$/.test(fileId)) fail('ARTIFACT_NOT_FOUND', '이 실행에서 파일을 찾을 수 없습니다.');
    const target = join(this.runDirectory(runId), fileId);
    directory(target);
    if (readdirSync(target).sort().join(',') !== 'data,record.json') fail('ARTIFACT_INTEGRITY', '파일 구성 목록이 변경되었습니다.');
    const value = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(readBounded(join(target, 'record.json'), 8192))) as Partial<StoredArtifact>;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'operationId,reference,requestHash,runId,schemaVersion'
      || value.schemaVersion !== 1 || value.runId !== runId || !validRef(value.reference) || value.reference.id !== fileId || typeof value.operationId !== 'string') fail('ARTIFACT_INTEGRITY', '파일 참조가 저장 기록과 일치하지 않습니다.');
    identity(value.operationId!); validateArtifactFilename(value.reference!.filename);
    const expectedId = `file_${canonicalDigest({ runId, operationId: value.operationId })}`;
    const reference = value.reference!;
    if (expectedId !== fileId || reference.relativePath !== `artifacts/${fileId}/${reference.filename}` || value.requestHash !== canonicalDigest({ filename: reference.filename, mimeType: reference.mimeType, bytes: reference.bytes, sha256: reference.sha256 })) fail('ARTIFACT_INTEGRITY', '파일 작업의 고정 정보가 변경되었습니다.');
    return value as StoredArtifact;
  }

  /** Scope comes from the authenticated run controller, never from model-generated file metadata. */
  read(runId: string, fileId: string): { reference: FileRef; bytes: Uint8Array } {
    const record = this.stored(runId, fileId);
    const bytes = readBounded(join(this.runDirectory(runId), fileId, 'data'), Math.min(this.limits.maxBytesPerFile, record.reference.bytes));
    if (bytes.length !== record.reference.bytes || hash(bytes) !== record.reference.sha256) fail('ARTIFACT_INTEGRITY', '원본 파일이 변경되었습니다.');
    return { reference: structuredClone(record.reference), bytes };
  }

  /** A well-shaped forged FileRef is still denied unless every field matches the current run's stored bytes. */
  resolve(runId: string, value: unknown): FileRef {
    try { assertJsonData(value); } catch { fail('ARTIFACT_REFERENCE_INVALID', '파일 참조는 일반 JSON 값이어야 합니다.'); }
    if (!validRef(value)) fail('ARTIFACT_REFERENCE_INVALID', '관리되는 파일 참조가 필요합니다.');
    const stored = this.read(runId, (value as FileRef).id).reference;
    if (canonicalDigest(value) !== canonicalDigest(stored)) fail('ARTIFACT_REFERENCE_INVALID', '전달한 파일 참조가 저장된 원본과 다릅니다.');
    return stored;
  }

  /** Stable operation identity makes retries safe; conflicting bytes never replace an earlier result. */
  put(runId: string, input: ArtifactWrite): FileRef {
    identity(runId); identity(input.operationId); validateArtifactFilename(input.filename);
    if (!(input.bytes instanceof Uint8Array) || input.bytes.length > this.limits.maxBytesPerFile) fail('ARTIFACT_SIZE_LIMIT', '파일 크기 한도를 초과했습니다.');
    const bytes = Uint8Array.from(input.bytes);
    const fileId = `file_${canonicalDigest({ runId, operationId: input.operationId })}`;
    const reference: FileRef = { id: fileId, relativePath: `artifacts/${fileId}/${input.filename}`, filename: input.filename, mimeType: input.mimeType, bytes: bytes.length, sha256: hash(bytes) };
    if (!validRef(reference)) fail('ARTIFACT_REFERENCE_INVALID', '파일의 형식이나 메타데이터가 올바르지 않습니다.');
    const requestHash = canonicalDigest({ filename: reference.filename, mimeType: reference.mimeType, bytes: reference.bytes, sha256: reference.sha256 });
    const runDir = this.runDirectory(runId, true); const destination = join(runDir, fileId);
    if (existsSync(destination)) {
      const stored = this.stored(runId, fileId);
      if (stored.requestHash !== requestHash) fail('ARTIFACT_OPERATION_CONFLICT', '같은 파일 작업 ID에 다른 내용이 전달되었습니다.');
      return this.read(runId, fileId).reference;
    }
    // Staging is invisible until the whole directory is renamed. Crashed staging is retained for controlled maintenance.
    const committed = readdirSync(runDir).filter(name => /^file_[a-f0-9]{64}$/.test(name));
    let total = bytes.length;
    for (const id of committed) total += this.stored(runId, id).reference.bytes;
    if (committed.length >= this.limits.maxFilesPerRun || total > this.limits.maxBytesPerRun) fail('ARTIFACT_QUOTA_EXCEEDED', '이 실행의 파일 개수 또는 전체 크기 한도를 초과했습니다.');
    const stage = join(runDir, `.pending-${randomUUID()}`);
    mkdirSync(stage, { mode: 0o700 });
    const record: StoredArtifact = { schemaVersion: 1, runId, operationId: input.operationId, requestHash, reference };
    try {
      for (const [name, content] of [['data', bytes], ['record.json', Buffer.from(JSON.stringify(record))]] as const) {
        const fd = openSync(join(stage, name), 'wx', 0o600);
        try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
      }
      directory(runDir); directory(stage);
      renameSync(stage, destination);
    } finally {
      // Cleanup only the exact generated directory and its two known files; never recurse or follow links.
      const within = relative(runDir, stage);
      if (!within.startsWith('..') && !isAbsolute(within) && dirname(stage) === runDir && existsSync(stage)) {
        directory(stage);
        for (const name of ['data', 'record.json']) if (existsSync(join(stage, name))) unlinkSync(join(stage, name));
        rmdirSync(stage);
      }
    }
    return this.read(runId, fileId).reference;
  }
}

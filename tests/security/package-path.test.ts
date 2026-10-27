import { describe, expect, it } from 'vitest';
import { validatePackagePath, pathKey, assertProductionFile } from '../../packages/package-kit/src/archive/safe-path.js';

/** Exercise Windows alias and export boundaries without relying on the implementation's own expected values. */
describe('operational package paths', () => {
  it.each(['../secret', '/root/file', 'C:/secret', 'a\\b', 'a//b', 'a/./b', 'NUL.txt', 'COM1', 'folder./file', 'file:stream', 'folder /file', 'a\u0000b', 'LONGNA~1.txt', 'RESOUR~1/file.txt'])('rejects unsafe path %s', path => expect(() => validatePackagePath(path)).toThrow());
  it('accepts Unicode resources and compares Windows aliases', () => { expect(validatePackagePath('resources/안내/문서.md')).toBe('resources/안내/문서.md'); expect(pathKey('A/File.txt')).toBe(pathKey('a/file.TXT')); });
  it('conservatively folds alternate Unicode case forms before collision checks', () => {
    expect(pathKey('resources/σ.txt')).toBe(pathKey('resources/ς.txt'));
    expect(pathKey('resources/µ.txt')).toBe(pathKey('resources/Μ.txt'));
    expect(pathKey('resources/ſ.txt')).toBe(pathKey('resources/S.txt'));
  });
  it('keeps operational skill code but rejects internal fixtures', () => { expect(() => assertProductionFile('resources/skill/scripts/clean.py', new TextEncoder().encode('# 실제 정리 작업\nprint(1)'))).not.toThrow(); expect(() => assertProductionFile('resources/skill/verification.spec.json', new Uint8Array())).toThrow(); });
});

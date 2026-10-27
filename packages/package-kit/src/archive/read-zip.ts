import { Inflate } from 'fflate';
import { PackageError } from '../errors.js';
import { pathKey, validatePackagePath } from './safe-path.js';

/** Limits are imposed by the importer, never by untrusted ZIP metadata. */
export interface ArchiveLimits { maxFiles: number; maxFileBytes: number; maxTotalBytes: number; maxRatio: number; maxManifestBytes: number; }
export const DEFAULT_LIMITS: ArchiveLimits = { maxFiles: 10000, maxFileBytes: 128 * 1024 ** 2, maxTotalBytes: 512 * 1024 ** 2, maxRatio: 100, maxManifestBytes: 4 * 1024 ** 2 };
type Entry = { name: string; size: number; compressed: number; crc: number; method: number; offset: number; dataStart: number };
const decoder = new TextDecoder('utf-8', { fatal: true });

/** CRC is checked independently of SHA-256 so malformed ZIP transport is rejected too. */
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Inspect central and local headers before decompression, retaining duplicates that generic unzip maps lose. */
export function readZip(bytes: Uint8Array, limits: ArchiveLimits): Map<string, Uint8Array> {
  const fail = (message: string): never => { throw new PackageError('INVALID_ZIP', message); };
  if (bytes.length < 22 || bytes.length > limits.maxTotalBytes + 4 * 1024 ** 2) fail('압축 파일 크기가 허용 범위를 벗어났습니다.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
    if (view.getUint32(at, true) === 0x06054b50 && at + 22 + view.getUint16(at + 20, true) === bytes.length) { end = at; break; }
  }
  if (end < 0) fail('ZIP 종료 레코드가 없습니다.');
  const count = view.getUint16(end + 10, true), centralSize = view.getUint32(end + 12, true), centralAt = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || count !== view.getUint16(end + 8, true) || count === 65535 || count > limits.maxFiles || centralAt + centralSize !== end) fail('분할·ZIP64 또는 잘못된 ZIP 목록입니다.');
  const entries: Entry[] = [], names = new Set<string>(), ranges: Array<[number, number]> = [];
  let at = centralAt, declaredTotal = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50) fail('ZIP 파일 목록이 손상되었습니다.');
    const flags = view.getUint16(at + 8, true), method = view.getUint16(at + 10, true), crc = view.getUint32(at + 16, true);
    const compressed = view.getUint32(at + 20, true), size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true), extraLength = view.getUint16(at + 30, true), commentLength = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true), unixType = (view.getUint32(at + 38, true) >>> 16) & 0xf000;
    if (at + 46 + nameLength + extraLength + commentLength > end || flags & 0x41 || ![0, 8].includes(method) || (unixType !== 0 && unixType !== 0x8000) || view.getUint16(at + 34, true)) fail('지원하지 않는 ZIP 항목입니다.');
    let name: string;
    try { name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength)); } catch { return fail('파일 이름이 UTF-8이 아닙니다.'); }
    validatePackagePath(name);
    const key = pathKey(name);
    if (names.has(key)) throw new PackageError('DUPLICATE_PATH', `중복된 패키지 경로: ${name}`);
    names.add(key);
    declaredTotal += size;
    if (size > limits.maxFileBytes || declaredTotal > limits.maxTotalBytes || size / Math.max(1, compressed) > limits.maxRatio || (name === 'manifest.json' && size > limits.maxManifestBytes)) throw new PackageError('ARCHIVE_LIMIT', '압축 해제 크기 또는 비율 한도를 초과했습니다.');
    // ZIP64 and link-related extension fields are unnecessary for this deliberately bounded format.
    for (let e = at + 46 + nameLength; e < at + 46 + nameLength + extraLength;) {
      if (e + 4 > at + 46 + nameLength + extraLength) fail('잘못된 ZIP 확장 필드입니다.');
      const tag = view.getUint16(e, true), length = view.getUint16(e + 2, true);
      if ([1, 0x000d].includes(tag) || e + 4 + length > at + 46 + nameLength + extraLength) fail('허용하지 않는 ZIP 확장 필드입니다.');
      e += 4 + length;
    }
    if (offset + 30 > centralAt || view.getUint32(offset, true) !== 0x04034b50 || view.getUint16(offset + 6, true) !== flags || view.getUint16(offset + 8, true) !== method) fail('ZIP 로컬 헤더가 일치하지 않습니다.');
    const localNameLength = view.getUint16(offset + 26, true), localExtraLength = view.getUint16(offset + 28, true);
    const dataStart = offset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressed > centralAt || decoder.decode(bytes.subarray(offset + 30, offset + 30 + localNameLength)) !== name) fail('ZIP 로컬 이름 또는 범위가 다릅니다.');
    if (!(flags & 8) && (view.getUint32(offset + 14, true) !== crc || view.getUint32(offset + 18, true) !== compressed || view.getUint32(offset + 22, true) !== size)) fail('ZIP 로컬 크기 또는 CRC가 다릅니다.');
    ranges.push([offset, dataStart + compressed]);
    entries.push({ name, size, compressed, crc, method, offset, dataStart });
    at += 46 + nameLength + extraLength + commentLength;
  }
  if (at !== end) fail('ZIP 목록의 실제 길이가 일치하지 않습니다.');
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) if (ranges[i]![0] < ranges[i - 1]![1]) fail('ZIP 데이터 영역이 겹칩니다.');
  const files = new Map<string, Uint8Array>();
  let total = 0;
  for (const entry of entries) {
    const chunks: Uint8Array[] = []; let length = 0;
    const accept = (chunk: Uint8Array) => {
      length += chunk.length; total += chunk.length;
      if (length > entry.size || length > limits.maxFileBytes || total > limits.maxTotalBytes) throw new PackageError('ARCHIVE_LIMIT', '실제 압축 해제 크기가 한도를 초과했습니다.');
      chunks.push(chunk.slice());
    };
    const compressed = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressed);
    if (entry.method === 0) accept(compressed);
    else {
      // Tiny compressed chunks bound allocation before the output callback can enforce actual-byte limits.
      const inflater = new Inflate((chunk) => accept(chunk));
      if (compressed.length === 0) fail('빈 DEFLATE 스트림입니다.');
      for (let start = 0; start < compressed.length; start += 256) inflater.push(compressed.subarray(start, start + 256), start + 256 >= compressed.length);
    }
    if (length !== entry.size) fail('해제된 파일 크기가 일치하지 않습니다.');
    const result = new Uint8Array(length); let cursor = 0;
    for (const chunk of chunks) { result.set(chunk, cursor); cursor += chunk.length; }
    if (crc32(result) !== entry.crc) fail('파일 CRC가 일치하지 않습니다.');
    files.set(entry.name, result);
  }
  return files;
}

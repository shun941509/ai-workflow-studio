import { PackageError } from '../errors.js';

/** Windows and Unicode aliases are rejected before extraction; paths are never silently rewritten. */
export function validatePackagePath(path: string): string {
  if (!path || path.length > 1024 || path.normalize('NFC') !== path || /[\\:\x00-\x1f\x7f-\x9f<>"|?*]/u.test(path) || path.startsWith('/')) {
    throw new PackageError('UNSAFE_PATH', `허용되지 않은 패키지 경로: ${path.slice(0, 120)}`);
  }
  for (const segment of path.split('/')) {
    if (!segment || segment === '.' || segment === '..' || /[. ]$/.test(segment) || segment.length > 255 || /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu.test(segment)) {
      throw new PackageError('UNSAFE_PATH', `모호하거나 예약된 패키지 경로: ${path.slice(0, 120)}`);
    }
    // Short-name aliases can resolve to an already-created long name on Windows volumes with 8.3 enabled.
    if (/^[^.~]{1,6}~[0-9]+(?:\.[^.]{1,3})?$/u.test(segment)) throw new PackageError('UNSAFE_PATH', 'Windows 짧은 파일 이름 별칭을 사용할 수 없습니다.');
  }
  return path;
}

/** Case-insensitive comparison prevents two ZIP names from overwriting the same Windows file. */
export function pathKey(path: string): string { return validatePackagePath(path).toUpperCase().toLowerCase().normalize('NFC'); }

/** Product exports allow operational resources, but never repository internals or credential files. */
export function assertProductionFile(path: string, bytes: Uint8Array): void {
  validatePackagePath(path);
  if (/(^|\/)(node_modules|\.git|__tests__|fixtures|coverage|\.next)(\/|$)/i.test(path) || /(^|\/)\.env(?:\.|$)/i.test(path) || /(?:verification\.spec\.json|\.test\.[^/]+|\.spec\.[^/]+|\.pem|\.key)$/i.test(path)) {
    throw new PackageError('NON_PRODUCTION_FILE', `운영 ZIP에 포함할 수 없는 파일: ${path}`);
  }
  // The scan is an extra guard; the primary protection is that credentials never enter package inputs.
  if (bytes.length <= 8 * 1024 * 1024) {
    const text = new TextDecoder().decode(bytes);
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}/.test(text)) {
      throw new PackageError('SECRET_DETECTED', `비밀정보로 보이는 값이 포함되어 있습니다: ${path}`);
    }
  }
}

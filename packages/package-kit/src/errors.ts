/** Machine-readable errors let the editor highlight a rejected archive without exposing file contents. */
export class PackageError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'PackageError'; }
}

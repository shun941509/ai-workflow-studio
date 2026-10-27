/** Generated from canonical JSON Schemas. Run pnpm generate:spec; do not edit by hand. */

/**
 * Runner-issued reference to immutable managed bytes. The caller must still authorize the current run and verify the persisted descriptor; shape validation grants no access.
 */
export interface FileRef {
  id: string;
  relativePath: string;
  filename: string;
  mimeType: string;
  bytes: number;
  sha256: string;
}

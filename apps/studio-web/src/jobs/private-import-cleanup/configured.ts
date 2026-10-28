import 'server-only';
import { authoringServiceClient } from '../../server/authoring-service';
import { CleanupError, runPrivateImportCleanup, type CleanupRepository } from './worker';

/** This is an internal server entry point, not a Server Action, public route, timer, or process started at import time. */
export async function runConfiguredPrivateImportCleanup(options: { limit?: number; signal?: AbortSignal } = {}) {
  const repository: CleanupRepository = {
    async claim(limit, signal) {
      const { data, error } = await authoringServiceClient(signal).rpc('claim_private_import_cleanup', { p_limit: limit });
      if (error) throw new CleanupError('CLEANUP_CLAIM_UNAVAILABLE'); return data;
    },
    async openObject(path, signal) {
      // The shared fetch adapter checks destination, redirect, elapsed time and actual streamed 32 MiB before SDK Blob allocation.
      const { data, error } = await authoringServiceClient(signal).storage.from('authoring-imports').download(path);
      if (error) {
        // SDK status comes from HTTP Response.status; statusCode/code may be untrusted error-body text (including a forged 404).
        if (error.name === 'StorageApiError' && error.status === 404) return new Response(null, { status: 404 });
        throw new CleanupError('CLEANUP_OBJECT_UNAVAILABLE');
      }
      if (!data) throw new CleanupError('CLEANUP_OBJECT_UNAVAILABLE');
      return new Response(data, { headers: { 'Content-Length': String(data.size) } });
    },
    async removeObject(path, signal) {
      // A one-element exact key array is the only mutation. No list, prefix expansion, recursion or fallback bucket is exposed.
      const { error } = await authoringServiceClient(signal).storage.from('authoring-imports').remove([path]);
      if (error) throw new CleanupError('CLEANUP_DELETE_UNKNOWN');
    },
    async finish(jobId, leaseId, outcome, signal) {
      const { error } = await authoringServiceClient(signal).rpc('finish_private_import_cleanup', { p_job: jobId, p_lease: leaseId, p_outcome: outcome });
      if (error) throw new CleanupError('CLEANUP_FINISH_UNCONFIRMED');
    },
  };
  return runPrivateImportCleanup(repository, options);
}

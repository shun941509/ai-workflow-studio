/** Internal service entry point only: this module registers no HTTP route, workflow handler, MCP tool, or capability. */
export { SqliteRagStore } from './store.js';
export { RagStoreError, DEFAULT_RAG_STORE_LIMITS } from './contracts.js';
export type { RagStoreLimits, StagedGeneration, ActiveIndex, SubjectMembership, AccessReplacement } from './contracts.js';

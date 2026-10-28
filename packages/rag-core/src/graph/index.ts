// Public data-only graph foundation. No Runner capability or external extraction/summary engine is declared here.
export * from './contracts.js';
export { createGraphSpan } from './provenance.js';
export { graphEntityId, buildGraphIndex, openGraphIndex, GraphIndex } from './artifact.js';
export { searchGraphLocal } from './local-search.js';

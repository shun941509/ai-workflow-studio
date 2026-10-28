/** CSP-safe transport validation. Importing this entry point must never load a runtime schema compiler. */
export { validateRunOutcome } from './run-outcome-validation.js';
export type { RunOutcome, CompletionCheck } from './generated/run-outcome.generated.js';

/** Generated from canonical JSON Schemas. Run pnpm generate:spec; do not edit by hand. */

export type CompletionCriterion =
  | {
      id: string;
      label: string;
      kind: 'result_schema';
      schema: UserSchema;
    }
  | {
      id: string;
      label: string;
      kind: 'review_accepted' | 'evaluate_passed' | 'agentic_answered' | 'loop_condition_met';
      /**
       * Exact root-flow node identity selected as the final acceptance evidence; child scope guesses and historical vetoes are forbidden.
       */
      nodeId: string;
    };
/**
 * Untrusted user JSON Schema is additionally checked for supported keywords, safe references and complexity.
 */
export type UserSchema =
  | boolean
  | {
      [k: string]: JsonValue;
    };
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | {
      [k: string]: JsonValue;
    };

export interface CompletionContract {
  version: 1;
  /**
   * @minItems 1
   * @maxItems 32
   */
  criteria: [CompletionCriterion, ...CompletionCriterion[]];
}

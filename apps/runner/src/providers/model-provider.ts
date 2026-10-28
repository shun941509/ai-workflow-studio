/** A provider receives credentials only in a transient invocation context. */
export interface ModelRequest {
  model: string;
  instructions: string;
  content: unknown;
  maxOutputTokens: number;
  responseFormat: { mode: 'text' } | { mode: 'json'; schema: unknown };
  /** Explicit fixed-protocol option; omitted legacy chat requests retain their existing wire representation. */
  reasoning?: { effort: 'none' };
}

export interface ModelResponse {
  text: string;
  responseId?: string;
  model?: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
}

export interface ModelProvider {
  /** This remote counting call transmits the same model input but must never generate a response. No local estimate fallback. */
  countInputTokens(request: ModelRequest, context: { apiKey: string; signal: AbortSignal }): Promise<number>;
  generate(request: ModelRequest, context: { apiKey: string; signal: AbortSignal }): Promise<ModelResponse>;
}

/** Unknown outcomes retain budget reservations and are never automatically replayed. */
export class ModelError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly outcome: 'not_started' | 'unknown' | 'completed',
    public readonly retryable = false,
    // Completed failures may still have confirmed billable usage; do not discard it as an unknown reservation.
    public readonly usage: ModelResponse['usage'] = null,
  ) { super(message); this.name = 'ModelError'; }
}

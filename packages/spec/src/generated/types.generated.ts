/** Generated from canonical JSON Schemas. Run pnpm generate:spec; do not edit by hand. */

/**
 * Untrusted user JSON Schema is additionally checked for supported keywords, safe references and complexity.
 */
export type UserSchema =
  | boolean
  | {
      [k: string]: JsonValue | undefined;
    };
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | {
      [k: string]: JsonValue | undefined;
    };
export type WorkflowNode =
  | InputNode
  | FormNode
  | TriggerNode
  | AiNode
  | AgentNode
  | ClassifyNode
  | OutputNode
  | ToolNode
  | RetrievalNode
  | KnowledgeNode
  | ResourceNode
  | SkillNode
  | MemoryNode
  | CompensateNode
  | TransformNode
  | ProgramNode
  | CandidateSearchNode
  | MergeNode
  | ConditionNode
  | GuardrailNode
  | EvaluateNode
  | ErrorNode
  | ReviewNode
  | FileInputNode
  | DocumentExtractNode
  | FileOutputNode
  | ParallelNode
  | AgentTeamNode
  | OrchestratorNode
  | SubworkflowNode
  | LoopNode;
export type Binding =
  | {
      from: 'literal';
      value: JsonValue;
    }
  | {
      from: 'workflowInput';
      pointer: string;
      onMissing: 'error';
    }
  | {
      from: 'workflowInput';
      pointer: string;
      onMissing: 'omit';
    }
  | {
      from: 'workflowInput';
      pointer: string;
      onMissing: 'default';
      defaultValue: JsonValue;
    }
  | {
      from: 'node';
      nodeId: string;
      pointer: string;
      onMissing: 'error';
    }
  | {
      from: 'node';
      nodeId: string;
      pointer: string;
      onMissing: 'omit';
    }
  | {
      from: 'node';
      nodeId: string;
      pointer: string;
      onMissing: 'default';
      defaultValue: JsonValue;
    }
  | {
      from: 'resource';
      resource: string;
      pointer: string;
      onMissing: 'error';
    }
  | {
      from: 'resource';
      resource: string;
      pointer: string;
      onMissing: 'omit';
    }
  | {
      from: 'resource';
      resource: string;
      pointer: string;
      onMissing: 'default';
      defaultValue: JsonValue;
    }
  | {
      from: 'error';
      pointer: string;
      onMissing: 'error';
    }
  | {
      from: 'error';
      pointer: string;
      onMissing: 'omit';
    }
  | {
      from: 'error';
      pointer: string;
      onMissing: 'default';
      defaultValue: JsonValue;
    };
export type ToolRef =
  | {
      kind: 'builtin';
      id: string;
      version: number;
    }
  | {
      kind: 'mcp';
      connection: string;
      name: string;
      schemaSha256: string;
    };
export type FlowRef =
  | {
      kind: 'local';
      flowId: string;
    }
  | {
      kind: 'package';
      workflowId: string;
      revision: number;
      sha256: string;
    };
export type Expression =
  | {
      literal: JsonValue;
    }
  | {
      var: string;
    }
  | {
      op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'and' | 'or' | 'not' | 'exists' | 'in';
      /**
       * @minItems 1
       */
      args: [Expression, ...Expression[]];
    };

export interface Workflow {
  schemaVersion: '1.0.0';
  id: string;
  revision: number;
  name: string;
  description?: string;
  entryNodeId: string;
  inputs: UserSchema;
  outputs: UserSchema;
  /**
   * @minItems 2
   */
  nodes: [WorkflowNode, WorkflowNode, ...WorkflowNode[]];
  /**
   * @minItems 0
   */
  edges: WorkflowEdge[];
  modelProfiles: {
    [k: string]:
      | {
          kind: 'chat' | 'embedding' | 'reranker';
          /**
           * @minItems 0
           */
          requiredFeatures: string[];
        }
      | undefined;
  };
  resources: {
    [k: string]: ResourceRef | undefined;
  };
  subworkflows: {
    [k: string]: FlowDefinition | undefined;
  };
  policy: WorkflowPolicy;
}
export interface InputNode {
  id: string;
  type: 'input';
  typeVersion: 1;
  label: string;
  description?: string;
  inputBindings: {
    [k: string]: Binding | undefined;
  };
  config: {};
  /**
   * @minItems 0
   */
  attachments: Attachment[];
  execution: ExecutionPolicy;
}
export interface Attachment {
  resource: string;
  role: 'instructions' | 'reference' | 'skill' | 'tool' | 'knowledge' | 'template';
}
export interface ExecutionPolicy {
  timeoutMs: number;
  retry: {
    maxAttempts: number;
    backoffMs: number;
    /**
     * @minItems 0
     */
    retryOn: ('TRANSIENT_NETWORK' | 'RATE_LIMITED' | 'PROVIDER_UNAVAILABLE')[];
  };
  onError: 'fail' | 'route';
  waitTtlMs?: number;
}
export interface FormNode {
  id: string;
  type: 'form';
  typeVersion: 1;
  label: string;
  description?: string;
  inputBindings: {
    [k: string]: Binding | undefined;
  };
  config:
    | {
        mode: 'initial';
        title: string;
      }
    | {
        mode: 'request';
        title: string;
        schema: UserSchema;
      };
  /**
   * @minItems 0
   */
  attachments: Attachment[];
  execution: ExecutionPolicy;
}
export interface TriggerNode {
  id: string;
  type: 'trigger';
  typeVersion: 1;
  label: string;
  description?: string;
  inputBindings: {
    [k: string]: Binding | undefined;
  };
  config: {
    kind: 'schedule';
    cron: string;
    timeZone: string;
    misfire: 'skip' | 'run_once';
    overlap: 'skip' | 'queue_one';
  };
  /**
   * @minItems 0
   */
  attachments: Attachment[];
  execution: ExecutionPolicy;
}
export interface AiNode {
  id: string;
  type: 'ai';
  typeVersion: 1;
  label: string;
  description?: string;
  inputBindings: {
    [k: string]: Binding | undefined;
  };
  config: {
    modelProfile: string;
    instructions: string;
    responseFormat:
      | {
          mode: 'text';
        }
      | {
          mode: 'json';
          schema: UserSchema;
        };
    maxOutputTokens: number;
  };
  /**
   * @minItems 0
   */
  attachments: Attachment[];
  execution: ExecutionPolicy;
}
export interface AgentNode {
  id: string;
  type: 'agent';
  typeVersion: 1;
  label: string;
  description?: string;
  inputBindings: {
    [k: string]: Binding | undefined;
  };
  config: {
    modelProfile: string;
    instructions: string;
    /**
     * @minItems 0
     */
    toolAllowlist: ToolRef[];
    maxSteps: number;
    resultSchema: UserSchema;
    strategy: 'task' | 'agentic_rag';
    retrievalPolicy?: {
      maxRounds: number;
      maxQueriesPerRound: number;
      maxRetrievedChunks: number;
      maxContextTokens: number;
      onInsufficient: 'abstain' | 'ask';
      clarificationFlowRef?: FlowRef;
    };
  };
  /**
   * @minItems 0
   */
  attachments: Attachment[];
  execution: ExecutionPolicy;
}
export interface ClassifyNode {
  id: string;
  type: 'classify';
  typeVersion: 1;
  label: string;
  description?: string;
  inputBindings: {
    [k: string]: Binding | undefined;
  };
  config: {
    modelProfile: string;
    /**
     * @minItems 1
     */
    labels: [
      {
        id: string;
        description: string;
      },
      ...{
        id: string;
        description: string;
      }[]
    ];
    onUncertain: 'unclassified';
  };
  /**
   * @minItems 0
   */
  attachments: Attachment[];
  execution: ExecutionPolicy;
}
export interface OutputNode {
  id: string;
  type: 'output';
  typeVersion: 1;
  label: string;
  description?: string;
  inputBindings: {
    [k: string]: Binding | undefined;
  };
  config: {
    format: 'text' | 'json' | 'files';
  };
  /**
   * @minItems 0
   */
  attachments: Attachment[];
  execution: ExecutionPolicy;
}
export interface ToolNode {
  id: string;
  type: 'tool';
  typeVersion: 1;
  label: string;
  description?: string;
  inputBindings: {
    [k: string]: Binding | undefined;
  };
  config: {
    tool: ToolRef;
  };
  /**
   * @minItems 0
   */
  attachments: Attachment[];
  execution: ExecutionPolicy;
}
export interface RetrievalNode {
  id: string;
  type: 'retrieval';
  typeVersion: 1;
  label: string;
  description?: string;
  inputBindings: {
    [k: string]: Binding | undefined;
  };
  config: {
    mode: 'keyword' | 'vector' | 'web' | 'hybrid' | 'graph_local' | 'graph_global';
    topK: number;
    maxContextTokens: number;
    keywordTopK?: number;
    vectorTopK?: number;
    candidateLimit?: number;
    fusion?: {
      method: 'rrf';
      k: number;
    };
    reranker?: {
      modelProfile: string;
      timeoutMs: number;
      onFailure: 'fail' | 'use_original';
    };
    /**
     * @minItems 0
     */
    allowedOrigins?: string[];
    maxHops?: number;
    maxCommunities?: number;
    communityLevel?: number;
  };
  /**
   * @minItems 0
   */
  attachments: Attachment[];
  execution: ExecutionPolicy;
}
export interface KnowledgeNode {
  id: string;
  type: 'knowledge';
  typeVersion: 1;
  label: string;
  description?: string;
  inputBindings: {
    [k: string]: Binding | undefined;
  };
  config: {
    operation: 'build' | 'update' | 'open' | 'delete';
    profile?: string;
    indexSettings?: {
      kind: 'keyword' | 'vector' | 'hybrid' | 'graph';
      chunkSize: number;
      chunkOverlap: number;
      embeddingProfile?: string;
      graphExtractionProfile?: string;
      graphSummaryProfile?: string;
      /**
       * @minItems 0
       */
      entityTypes?: string[];
      /**
       * @minItems 0
       */
      relationTypes?: string[];
    };
  };
  /**
   * @minItems 0
   */
  attachments: Attachment[];
  execution: ExecutionPolicy;
}
export interface ResourceNode {
  id: string;
  type: 'resource';
  typeVersion: 1;
  label: string;
  description?: string;
  inputBindings: {
    [k: string]: Binding | undefined;
  };
  config: {
    resource: string;
    pointer?: string;
  };
  /**
   * @minItems 0
   */
  attachments: Attachment[];
  execution: ExecutionPolicy;
}
export interface SkillNode {
  id: string;
  type: 'skill';
  typeVersion: 1;
  label: string;
  description?: string;
  inputBindings: {
    [k: string]: Binding | undefined;
  };
  config: {
    resource: string;
    mode: 'instructions' | 'execute';
    entrypoint?: string;
    workerProfile?: string;
    resultSchema?: UserSchema;
  };
  /**
   * @minItems 0
   */
  attachments: Attachment[];
  execution: ExecutionPolicy;
}
export interface MemoryNode {
  id: string;
  type: 'memory';
  typeVersion: 1;
  label: string;
  description?: string;
  inputBindings: {
    [k: string]: Binding | undefined;
  };
  config: {
    operation: 'get' | 'put' | 'delete';
    scope: 'run' | 'project';
    ttlMs?: number;
  };
  /**
   * @minItems 0
   */
  attachments: Attachment[];
  execution: ExecutionPolicy;
}
export interface CompensateNode {
  id: string;
  type: 'compensate';
  typeVersion: 1;
  label: string;
  description?: string;
  inputBindings: {
    [k: string]: Binding | undefined;
  };
  config: {
    method: string;
  };
  /**
   * @minItems 0
   */
  attachments: Attachment[];
  execution: ExecutionPolicy;
}
export interface TransformNode {
  id: string;
  type: 'transform';
  typeVersion: 1;
  label: string;
  description?: string;
  inputBindings: {
    [k: string]: Binding | undefined;
  };
  config: {
    /**
     * @minItems 1
     */
    steps: [
      {
        op: 'pick' | 'omit' | 'rename' | 'map' | 'format' | 'parse_json' | 'stringify_json';
        options?: {
          [k: string]: JsonValue | undefined;
        };
      },
      ...{
        op: 'pick' | 'omit' | 'rename' | 'map' | 'format' | 'parse_json' | 'stringify_json';
        options?: {
          [k: string]: JsonValue | undefined;
        };
      }[]
    ];
    resultSchema: UserSchema;
  };
  /**
   * @minItems 0
   */
  attachments: Attachment[];
  execution: ExecutionPolicy;
}
export interface ProgramNode {
  id: string;
  type: 'program';
  typeVersion: 1;
  label: string;
  description?: string;
  inputBindings: {
    [k: string]: Binding | undefined;
  };
  config: {
    codeRef: {
      resource: string;
      path: string;
    };
    workerProfile: string;
    resultSchema: UserSchema;
  };
  /**
   * @minItems 0
   */
  attachments: Attachment[];
  execution: ExecutionPolicy;
}
export interface CandidateSearchNode {
  id: string;
  type: 'candidate_search';
  typeVersion: 1;
  label: string;
  description?: string;
  inputBindings: {
    [k: string]: Binding | undefined;
  };
  config: {
    mode: 'tree' | 'graph';
    generatorFlowRef: FlowRef;
    verifierId: string;
    maxCandidates: number;
    maxDepth: number;
    maxVerifications: number;
  };
  /**
   * @minItems 0
   */
  attachments: Attachment[];
  execution: ExecutionPolicy;
}
export interface MergeNode {
  id: string;
  type: 'merge';
  typeVersion: 1;
  label: string;
  description?: string;
  inputBindings: {
    [k: string]: Binding | undefined;
  };
  config: {
    waitFor: 'all_active';
    combine: 'object' | 'array' | 'select';
    collision: 'error' | 'namespace';
    selectKey?: string;
  };
  /**
   * @minItems 0
   */
  attachments: Attachment[];
  execution: ExecutionPolicy;
}
export interface ConditionNode {
  id: string;
  type: 'condition';
  typeVersion: 1;
  label: string;
  description?: string;
  inputBindings: {
    [k: string]: Binding | undefined;
  };
  config: {
    expression: Expression;
  };
  /**
   * @minItems 0
   */
  attachments: Attachment[];
  execution: ExecutionPolicy;
}
export interface GuardrailNode {
  id: string;
  type: 'guardrail';
  typeVersion: 1;
  label: string;
  description?: string;
  inputBindings: {
    [k: string]: Binding | undefined;
  };
  config: {
    /**
     * @minItems 1
     */
    rules: [
      {
        id: string;
        kind: 'schema' | 'length' | 'allowed_values' | 'required_fields';
        parameters: {
          [k: string]: JsonValue | undefined;
        };
      },
      ...{
        id: string;
        kind: 'schema' | 'length' | 'allowed_values' | 'required_fields';
        parameters: {
          [k: string]: JsonValue | undefined;
        };
      }[]
    ];
    onViolation: 'block';
  };
  /**
   * @minItems 0
   */
  attachments: Attachment[];
  execution: ExecutionPolicy;
}
export interface EvaluateNode {
  id: string;
  type: 'evaluate';
  typeVersion: 1;
  label: string;
  description?: string;
  inputBindings: {
    [k: string]: Binding | undefined;
  };
  config: {
    mode: 'rules' | 'model';
    resultSchema: UserSchema;
    passRule: Expression;
    modelProfile?: string;
    instructions?: string;
    /**
     * @minItems 0
     */
    rules?: {
      id: string;
      expression: Expression;
    }[];
  };
  /**
   * @minItems 0
   */
  attachments: Attachment[];
  execution: ExecutionPolicy;
}
export interface ErrorNode {
  id: string;
  type: 'error';
  typeVersion: 1;
  label: string;
  description?: string;
  inputBindings: {
    [k: string]: Binding | undefined;
  };
  config: {
    mode: 'recover' | 'rethrow';
  };
  /**
   * @minItems 0
   */
  attachments: Attachment[];
  execution: ExecutionPolicy;
}
export interface ReviewNode {
  id: string;
  type: 'review';
  typeVersion: 1;
  label: string;
  description?: string;
  inputBindings: {
    [k: string]: Binding | undefined;
  };
  config: {
    question: string;
    responseSchema: UserSchema;
  };
  /**
   * @minItems 0
   */
  attachments: Attachment[];
  execution: ExecutionPolicy;
}
export interface FileInputNode {
  id: string;
  type: 'file_input';
  typeVersion: 1;
  label: string;
  description?: string;
  inputBindings: {
    [k: string]: Binding | undefined;
  };
  config: {
    /**
     * @minItems 1
     */
    mimeTypes: [string, ...string[]];
    maxFiles: number;
    maxBytesPerFile: number;
  };
  /**
   * @minItems 0
   */
  attachments: Attachment[];
  execution: ExecutionPolicy;
}
export interface DocumentExtractNode {
  id: string;
  type: 'document_extract';
  typeVersion: 1;
  label: string;
  description?: string;
  inputBindings: {
    [k: string]: Binding | undefined;
  };
  config: {
    mode: 'text' | 'table' | 'ocr';
    /**
     * @minItems 0
     */
    languages?: string[];
    workerProfile?: string;
  };
  /**
   * @minItems 0
   */
  attachments: Attachment[];
  execution: ExecutionPolicy;
}
export interface FileOutputNode {
  id: string;
  type: 'file_output';
  typeVersion: 1;
  label: string;
  description?: string;
  inputBindings: {
    [k: string]: Binding | undefined;
  };
  config: {
    format: 'text' | 'markdown' | 'json' | 'csv' | 'html' | 'docx' | 'pdf' | 'copy';
    filename: string;
    outputDirectory: string;
    workerProfile?: string;
  };
  /**
   * @minItems 0
   */
  attachments: Attachment[];
  execution: ExecutionPolicy;
}
export interface ParallelNode {
  id: string;
  type: 'parallel';
  typeVersion: 1;
  label: string;
  description?: string;
  inputBindings: {
    [k: string]: Binding | undefined;
  };
  config: {
    /**
     * @minItems 1
     */
    branches: [
      {
        id: string;
        flowRef: FlowRef;
      },
      ...{
        id: string;
        flowRef: FlowRef;
      }[]
    ];
    mode: 'all' | 'first_match';
    maxConcurrency: number;
    failurePolicy: 'fail_fast' | 'collect';
    matchExpression?: Expression;
  };
  /**
   * @minItems 0
   */
  attachments: Attachment[];
  execution: ExecutionPolicy;
}
export interface AgentTeamNode {
  id: string;
  type: 'agent_team';
  typeVersion: 1;
  label: string;
  description?: string;
  inputBindings: {
    [k: string]: Binding | undefined;
  };
  config: {
    /**
     * @minItems 1
     */
    members: [
      {
        id: string;
        role: string;
        flowRef: FlowRef;
      },
      ...{
        id: string;
        role: string;
        flowRef: FlowRef;
      }[]
    ];
    mode: 'sequential' | 'parallel';
    maxConcurrency: number;
    integrationFlowRef?: FlowRef;
  };
  /**
   * @minItems 0
   */
  attachments: Attachment[];
  execution: ExecutionPolicy;
}
export interface OrchestratorNode {
  id: string;
  type: 'orchestrator';
  typeVersion: 1;
  label: string;
  description?: string;
  inputBindings: {
    [k: string]: Binding | undefined;
  };
  config: {
    mode: 'plan' | 'adaptive' | 'dynamic';
    /**
     * @minItems 1
     */
    allowedFlows: [FlowRef, ...FlowRef[]];
    modelProfile: string;
    maxReplans: number;
    maxTasks: number;
  };
  /**
   * @minItems 0
   */
  attachments: Attachment[];
  execution: ExecutionPolicy;
}
export interface SubworkflowNode {
  id: string;
  type: 'subworkflow';
  typeVersion: 1;
  label: string;
  description?: string;
  inputBindings: {
    [k: string]: Binding | undefined;
  };
  config: {
    flowRef: FlowRef;
  };
  /**
   * @minItems 0
   */
  attachments: Attachment[];
  execution: ExecutionPolicy;
}
export interface LoopNode {
  id: string;
  type: 'loop';
  typeVersion: 1;
  label: string;
  description?: string;
  inputBindings: {
    [k: string]: Binding | undefined;
  };
  config: {
    mode: 'foreach' | 'until';
    bodyFlowRef: FlowRef;
    maxIterations: number;
    untilExpression?: Expression;
  };
  /**
   * @minItems 0
   */
  attachments: Attachment[];
  execution: ExecutionPolicy;
}
export interface WorkflowEdge {
  id: string;
  from: {
    nodeId: string;
    port: string;
  };
  to: {
    nodeId: string;
    port: string;
  };
}
export interface ResourceRef {
  kind: 'mcp' | 'instruction' | 'document' | 'skill';
  id: string;
  revision: number;
  sha256: string;
}
export interface FlowDefinition {
  entryNodeId: string;
  inputs: UserSchema;
  outputs: UserSchema;
  /**
   * @minItems 2
   */
  nodes: [WorkflowNode, WorkflowNode, ...WorkflowNode[]];
  /**
   * @minItems 0
   */
  edges: WorkflowEdge[];
}
export interface WorkflowPolicy {
  approvalMode: 'per_effect';
  networkMode: 'broker_only';
  filesystemMode: 'workspace_only';
  limits: {
    maxConcurrentNodes: number;
    maxNodeInstances: number;
    maxModelCalls: number;
    maxTotalTokens: number;
    maxActiveMs: number;
    maxChildDepth: number;
  };
}

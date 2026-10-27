/** Generated from canonical catalogue JSON Schemas; do not edit by hand. */
export interface OfficialExample {
  schemaVersion: '1.0.0';
  id: string;
  kind: 'project' | 'resource';
  resourceKind?: 'mcp' | 'instruction' | 'document' | 'skill';
  name: string;
  state: 'planned' | 'implemented' | 'verified' | 'published' | 'suspended';
  source: {
    path: 'docs/specifications/official-catalog-design.md';
    row: string;
    referenceUrl?: string;
  };
  definition: {
    purpose: string;
    blocksAndConnections: string;
    inputOutput: string;
    acceptanceCriteria: string;
  };
  /**
   * @minItems 1
   */
  blocks: [string, ...string[]];
  /**
   * @minItems 1
   */
  requiredCapabilities: [string, ...string[]];
  externalDependencies: {
    id: string;
    kind: 'model' | 'service' | 'embedding' | 'reranker' | 'graph' | 'browser' | 'database' | 'search';
    requirement: string;
  }[];
  /**
   * @minItems 1
   */
  targetHosts: ['codex' | 'claude-code' | 'opencode', ...('codex' | 'claude-code' | 'opencode')[]];
  requiresExtension: boolean;
  artifact?: {
    rootPath: string;
    entrypoint: string;
    sha256: string;
    /**
     * @minItems 3
     * @maxItems 1000
     */
    files: [
      {
        path: string;
        sha256: string;
        role: 'entrypoint' | 'readme' | 'license' | 'payload' | 'sample-input';
      },
      {
        path: string;
        sha256: string;
        role: 'entrypoint' | 'readme' | 'license' | 'payload' | 'sample-input';
      },
      {
        path: string;
        sha256: string;
        role: 'entrypoint' | 'readme' | 'license' | 'payload' | 'sample-input';
      },
      ...{
        path: string;
        sha256: string;
        role: 'entrypoint' | 'readme' | 'license' | 'payload' | 'sample-input';
      }[]
    ];
  };
  verificationRecords: {
    path: string;
    sha256: string;
  }[];
  review?: {
    reviewerId: string;
    reviewedAt: string;
    artifactSha256: string;
    distinctPurposeConfirmed: true;
  };
}

export interface VerificationRecord {
  schemaVersion: '1.0.0';
  id: string;
  exampleId: string;
  artifactSha256: string;
  definitionSha256: string;
  mode: 'real';
  mocked: false;
  status: 'passed';
  host: 'codex' | 'claude-code' | 'opencode';
  hostVersion: string;
  runnerVersion: string;
  startedAt: string;
  finishedAt: string;
  capabilities: string[];
  acceptanceCriteria: string;
  /**
   * @minItems 2
   */
  steps: [
    {
      kind: 'host-entry' | 'runner-start' | 'result-received' | 'resource-use' | 'acceptance-check';
      passed: true;
      evidencePath: string;
    },
    {
      kind: 'host-entry' | 'runner-start' | 'result-received' | 'resource-use' | 'acceptance-check';
      passed: true;
      evidencePath: string;
    },
    ...{
      kind: 'host-entry' | 'runner-start' | 'result-received' | 'resource-use' | 'acceptance-check';
      passed: true;
      evidencePath: string;
    }[]
  ];
  dependencies: {
    id: string;
    mode: 'actual';
    version: string;
    evidencePath: string;
  }[];
  /**
   * @minItems 1
   */
  evidence: [
    {
      path: string;
      sha256: string;
    },
    ...{
      path: string;
      sha256: string;
    }[]
  ];
  signature: {
    algorithm: 'Ed25519';
    keyId: string;
    value: string;
  };
}


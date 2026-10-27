/** Generated from runtime-lock.schema.json. Edit the schema, then regenerate. */

/**
 * Portable private-package requirements. Installed component, model and host identities are resolved locally into the immutable run plan; this is not a verified binary lock.
 */
export interface RuntimeRequirementsLock {
  schemaVersion: "1.0.0";
  kind: "requirements";
  workflowSha256: string;
  runner: {
    version: "0.1.0";
    node: "24.22.1";
  };
  requiredCapabilities: string[];
  host: {
    name: "codex" | "claude-code" | "opencode";
    verification: "unverified";
    /**
     * @maxItems 0
     */
    testedVersions: [];
  };
  modelProfiles: {
    [k: string]: unknown;
  };
  modelVerification: "unverified";
}

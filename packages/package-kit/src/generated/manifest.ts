/** Generated from package-manifest.schema.json. Edit the schema, then regenerate. */

/**
 * 운영 배포의 요청 권한과 파일 무결성 선언. 실행 승인이나 실제 호스트 검증을 대신하지 않는다.
 */
export interface PackageManifest {
  schemaVersion: "1.0.0";
  packageId: string;
  packageVersion: string;
  packageKind: "workflow" | "materials";
  purpose: "production";
  targetHost: "codex" | "claude-code" | "opencode";
  entrypoint: string | null;
  requiredCapabilities: string[];
  compatibility: {
    runner: string;
    host: {
      verification: "unverified" | "verified";
      testedVersions: string[];
    };
    /**
     * @minItems 1
     */
    platforms: ["win32-x64" | "win32-arm64", ...("win32-x64" | "win32-arm64")[]];
  };
  requestedPermissions: {
    kind: "model" | "resource" | "connection" | "capability";
    target: string;
  }[];
  requiredConnections: string[];
  resources: {
    [k: string]: {};
  };
  indexes: {
    id: string;
    policy: "rebuild" | "bundled";
  }[];
  /**
   * @minItems 1
   * @maxItems 10000
   */
  files: [
    {
      path: string;
      bytes: number;
      sha256: string;
      role:
        | "workflow"
        | "editor"
        | "runtime-lock"
        | "instructions"
        | "host-config"
        | "skill"
        | "resource"
        | "documentation"
        | "license"
        | "index";
    },
    ...{
      path: string;
      bytes: number;
      sha256: string;
      role:
        | "workflow"
        | "editor"
        | "runtime-lock"
        | "instructions"
        | "host-config"
        | "skill"
        | "resource"
        | "documentation"
        | "license"
        | "index";
    }[]
  ];
  createdAt: string;
}

/** Generated from resource-descriptor.schema.json. Edit the schema, then regenerate. */

export interface ResourceDescriptor {
  schemaVersion: "1.0.0";
  id: string;
  revision: number;
  kind: "instruction" | "document" | "skill" | "mcp";
  name: string;
  entrypoint: string;
  license: {
    id: string;
    path: string;
  };
  dependencies: {
    [k: string]: ResourceRef;
  };
  requiredConnections: string[];
  /**
   * @minItems 1
   * @maxItems 1000
   */
  files: [
    {
      path: string;
      bytes: number;
      sha256: string;
    },
    ...{
      path: string;
      bytes: number;
      sha256: string;
    }[]
  ];
}
export interface ResourceRef {
  kind: "mcp" | "instruction" | "document" | "skill";
  id: string;
  revision: number;
  sha256: string;
}

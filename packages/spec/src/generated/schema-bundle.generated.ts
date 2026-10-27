/** Generated from canonical JSON Schemas. Run pnpm generate:spec; do not edit by hand. */
export const schemaBundle: Record<string, unknown> = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:ai-workflow-studio:schema:workflow:1.0.0",
  "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
  "type": "object",
  "properties": {
    "schemaVersion": {
      "const": "1.0.0"
    },
    "id": {
      "type": "string",
      "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
    },
    "revision": {
      "type": "integer",
      "minimum": 1
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "description": {
      "type": "string",
      "maxLength": 4000
    },
    "entryNodeId": {
      "type": "string",
      "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
    },
    "inputs": {
      "$ref": "#/$defs/user_schema"
    },
    "outputs": {
      "$ref": "#/$defs/user_schema"
    },
    "nodes": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/node"
      },
      "minItems": 2
    },
    "edges": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/edge"
      },
      "minItems": 0
    },
    "modelProfiles": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "properties": {
          "kind": {
            "type": "string",
            "enum": [
              "chat",
              "embedding",
              "reranker"
            ]
          },
          "requiredFeatures": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "minItems": 0
          }
        },
        "required": [
          "kind",
          "requiredFeatures"
        ],
        "additionalProperties": false
      }
    },
    "resources": {
      "type": "object",
      "additionalProperties": {
        "$ref": "#/$defs/resource_ref"
      }
    },
    "subworkflows": {
      "type": "object",
      "additionalProperties": {
        "$ref": "#/$defs/flow"
      }
    },
    "policy": {
      "$ref": "#/$defs/policy"
    }
  },
  "required": [
    "schemaVersion",
    "id",
    "revision",
    "name",
    "entryNodeId",
    "inputs",
    "outputs",
    "nodes",
    "edges",
    "modelProfiles",
    "resources",
    "subworkflows",
    "policy"
  ],
  "additionalProperties": false,
  "title": "Workflow",
  "$defs": {
    "attachment": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "resource": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "role": {
          "type": "string",
          "enum": [
            "instructions",
            "reference",
            "skill",
            "tool",
            "knowledge",
            "template"
          ]
        }
      },
      "required": [
        "resource",
        "role"
      ],
      "additionalProperties": false,
      "title": "Attachment"
    },
    "binding": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "title": "Binding",
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "from": {
              "const": "literal"
            },
            "value": {
              "$ref": "#/$defs/json_value"
            }
          },
          "required": [
            "from",
            "value"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "from": {
              "const": "workflowInput"
            },
            "pointer": {
              "type": "string",
              "pattern": "^(?:/(?:[^~]|~[01])*)*$"
            },
            "onMissing": {
              "const": "error"
            }
          },
          "required": [
            "from",
            "pointer",
            "onMissing"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "from": {
              "const": "workflowInput"
            },
            "pointer": {
              "type": "string",
              "pattern": "^(?:/(?:[^~]|~[01])*)*$"
            },
            "onMissing": {
              "const": "omit"
            }
          },
          "required": [
            "from",
            "pointer",
            "onMissing"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "from": {
              "const": "workflowInput"
            },
            "pointer": {
              "type": "string",
              "pattern": "^(?:/(?:[^~]|~[01])*)*$"
            },
            "onMissing": {
              "const": "default"
            },
            "defaultValue": {
              "$ref": "#/$defs/json_value"
            }
          },
          "required": [
            "from",
            "pointer",
            "onMissing",
            "defaultValue"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "from": {
              "const": "node"
            },
            "nodeId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            },
            "pointer": {
              "type": "string",
              "pattern": "^(?:/(?:[^~]|~[01])*)*$"
            },
            "onMissing": {
              "const": "error"
            }
          },
          "required": [
            "from",
            "nodeId",
            "pointer",
            "onMissing"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "from": {
              "const": "node"
            },
            "nodeId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            },
            "pointer": {
              "type": "string",
              "pattern": "^(?:/(?:[^~]|~[01])*)*$"
            },
            "onMissing": {
              "const": "omit"
            }
          },
          "required": [
            "from",
            "nodeId",
            "pointer",
            "onMissing"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "from": {
              "const": "node"
            },
            "nodeId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            },
            "pointer": {
              "type": "string",
              "pattern": "^(?:/(?:[^~]|~[01])*)*$"
            },
            "onMissing": {
              "const": "default"
            },
            "defaultValue": {
              "$ref": "#/$defs/json_value"
            }
          },
          "required": [
            "from",
            "nodeId",
            "pointer",
            "onMissing",
            "defaultValue"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "from": {
              "const": "resource"
            },
            "resource": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            },
            "pointer": {
              "type": "string",
              "pattern": "^(?:/(?:[^~]|~[01])*)*$"
            },
            "onMissing": {
              "const": "error"
            }
          },
          "required": [
            "from",
            "resource",
            "pointer",
            "onMissing"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "from": {
              "const": "resource"
            },
            "resource": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            },
            "pointer": {
              "type": "string",
              "pattern": "^(?:/(?:[^~]|~[01])*)*$"
            },
            "onMissing": {
              "const": "omit"
            }
          },
          "required": [
            "from",
            "resource",
            "pointer",
            "onMissing"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "from": {
              "const": "resource"
            },
            "resource": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            },
            "pointer": {
              "type": "string",
              "pattern": "^(?:/(?:[^~]|~[01])*)*$"
            },
            "onMissing": {
              "const": "default"
            },
            "defaultValue": {
              "$ref": "#/$defs/json_value"
            }
          },
          "required": [
            "from",
            "resource",
            "pointer",
            "onMissing",
            "defaultValue"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "from": {
              "const": "error"
            },
            "pointer": {
              "type": "string",
              "pattern": "^(?:/(?:[^~]|~[01])*)*$"
            },
            "onMissing": {
              "const": "error"
            }
          },
          "required": [
            "from",
            "pointer",
            "onMissing"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "from": {
              "const": "error"
            },
            "pointer": {
              "type": "string",
              "pattern": "^(?:/(?:[^~]|~[01])*)*$"
            },
            "onMissing": {
              "const": "omit"
            }
          },
          "required": [
            "from",
            "pointer",
            "onMissing"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "from": {
              "const": "error"
            },
            "pointer": {
              "type": "string",
              "pattern": "^(?:/(?:[^~]|~[01])*)*$"
            },
            "onMissing": {
              "const": "default"
            },
            "defaultValue": {
              "$ref": "#/$defs/json_value"
            }
          },
          "required": [
            "from",
            "pointer",
            "onMissing",
            "defaultValue"
          ],
          "additionalProperties": false
        }
      ]
    },
    "edge": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "from": {
          "type": "object",
          "properties": {
            "nodeId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            },
            "port": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            }
          },
          "required": [
            "nodeId",
            "port"
          ],
          "additionalProperties": false
        },
        "to": {
          "type": "object",
          "properties": {
            "nodeId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            },
            "port": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            }
          },
          "required": [
            "nodeId",
            "port"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "id",
        "from",
        "to"
      ],
      "additionalProperties": false,
      "title": "WorkflowEdge"
    },
    "execution": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "timeoutMs": {
          "type": "integer",
          "minimum": 1,
          "maximum": 3600000
        },
        "retry": {
          "type": "object",
          "properties": {
            "maxAttempts": {
              "type": "integer",
              "minimum": 1,
              "maximum": 3
            },
            "backoffMs": {
              "type": "integer",
              "minimum": 0,
              "maximum": 60000
            },
            "retryOn": {
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "TRANSIENT_NETWORK",
                  "RATE_LIMITED",
                  "PROVIDER_UNAVAILABLE"
                ]
              },
              "minItems": 0
            }
          },
          "required": [
            "maxAttempts",
            "backoffMs",
            "retryOn"
          ],
          "additionalProperties": false
        },
        "onError": {
          "type": "string",
          "enum": [
            "fail",
            "route"
          ]
        },
        "waitTtlMs": {
          "type": "integer",
          "minimum": 1000,
          "maximum": 2592000000
        }
      },
      "required": [
        "timeoutMs",
        "retry",
        "onError"
      ],
      "additionalProperties": false,
      "title": "ExecutionPolicy"
    },
    "expression": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "title": "Expression",
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "literal": {
              "$ref": "#/$defs/json_value"
            }
          },
          "required": [
            "literal"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "var": {
              "type": "string",
              "pattern": "^(?:/(?:[^~]|~[01])*)*$"
            }
          },
          "required": [
            "var"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "op": {
              "type": "string",
              "enum": [
                "eq",
                "ne",
                "gt",
                "gte",
                "lt",
                "lte",
                "and",
                "or",
                "not",
                "exists",
                "in"
              ]
            },
            "args": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/expression"
              },
              "minItems": 1
            }
          },
          "required": [
            "op",
            "args"
          ],
          "additionalProperties": false
        }
      ]
    },
    "file_ref": {
      "title": "FileRef",
      "description": "Runner-issued reference to immutable managed bytes. The caller must still authorize the current run and verify the persisted descriptor; shape validation grants no access.",
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^file_[a-f0-9]{64}$"
        },
        "relativePath": {
          "type": "string",
          "minLength": 1,
          "maxLength": 512
        },
        "filename": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "mimeType": {
          "type": "string",
          "pattern": "^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$",
          "maxLength": 120
        },
        "bytes": {
          "type": "integer",
          "minimum": 0,
          "maximum": 134217728
        },
        "sha256": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        }
      },
      "required": [
        "id",
        "relativePath",
        "filename",
        "mimeType",
        "bytes",
        "sha256"
      ],
      "additionalProperties": false
    },
    "flow_ref": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "title": "FlowRef",
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "local"
            },
            "flowId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            }
          },
          "required": [
            "kind",
            "flowId"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "package"
            },
            "workflowId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            },
            "revision": {
              "type": "integer",
              "minimum": 1
            },
            "sha256": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            }
          },
          "required": [
            "kind",
            "workflowId",
            "revision",
            "sha256"
          ],
          "additionalProperties": false
        }
      ]
    },
    "flow": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "entryNodeId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "inputs": {
          "$ref": "#/$defs/user_schema"
        },
        "outputs": {
          "$ref": "#/$defs/user_schema"
        },
        "nodes": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/node"
          },
          "minItems": 2
        },
        "edges": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/edge"
          },
          "minItems": 0
        }
      },
      "required": [
        "entryNodeId",
        "inputs",
        "outputs",
        "nodes",
        "edges"
      ],
      "additionalProperties": false,
      "title": "FlowDefinition"
    },
    "json_value": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "title": "JsonValue",
      "anyOf": [
        {
          "type": "null"
        },
        {
          "type": "boolean"
        },
        {
          "type": "number"
        },
        {
          "type": "string"
        },
        {
          "type": "array",
          "items": {
            "$ref": "#/$defs/json_value"
          }
        },
        {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/json_value"
          }
        }
      ]
    },
    "node_common": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "type": {
          "type": "string",
          "enum": [
            "input",
            "form",
            "trigger",
            "ai",
            "agent",
            "classify",
            "output",
            "tool",
            "retrieval",
            "knowledge",
            "resource",
            "skill",
            "memory",
            "compensate",
            "transform",
            "program",
            "candidate_search",
            "merge",
            "condition",
            "guardrail",
            "evaluate",
            "error",
            "review",
            "file_input",
            "document_extract",
            "file_output",
            "parallel",
            "agent_team",
            "orchestrator",
            "subworkflow",
            "loop"
          ]
        },
        "typeVersion": {
          "const": 1
        },
        "label": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "description": {
          "type": "string",
          "maxLength": 2000
        },
        "inputBindings": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/binding"
          }
        },
        "config": {
          "type": "object"
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/attachment"
          },
          "minItems": 0
        },
        "execution": {
          "$ref": "#/$defs/execution"
        }
      },
      "required": [
        "id",
        "type",
        "typeVersion",
        "label",
        "inputBindings",
        "config",
        "attachments",
        "execution"
      ],
      "additionalProperties": false,
      "title": "NodeCommon"
    },
    "node": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "title": "WorkflowNode",
      "oneOf": [
        {
          "$ref": "#/$defs/nodes_input_v1"
        },
        {
          "$ref": "#/$defs/nodes_form_v1"
        },
        {
          "$ref": "#/$defs/nodes_trigger_v1"
        },
        {
          "$ref": "#/$defs/nodes_ai_v1"
        },
        {
          "$ref": "#/$defs/nodes_agent_v1"
        },
        {
          "$ref": "#/$defs/nodes_classify_v1"
        },
        {
          "$ref": "#/$defs/nodes_output_v1"
        },
        {
          "$ref": "#/$defs/nodes_tool_v1"
        },
        {
          "$ref": "#/$defs/nodes_retrieval_v1"
        },
        {
          "$ref": "#/$defs/nodes_knowledge_v1"
        },
        {
          "$ref": "#/$defs/nodes_resource_v1"
        },
        {
          "$ref": "#/$defs/nodes_skill_v1"
        },
        {
          "$ref": "#/$defs/nodes_memory_v1"
        },
        {
          "$ref": "#/$defs/nodes_compensate_v1"
        },
        {
          "$ref": "#/$defs/nodes_transform_v1"
        },
        {
          "$ref": "#/$defs/nodes_program_v1"
        },
        {
          "$ref": "#/$defs/nodes_candidate_search_v1"
        },
        {
          "$ref": "#/$defs/nodes_merge_v1"
        },
        {
          "$ref": "#/$defs/nodes_condition_v1"
        },
        {
          "$ref": "#/$defs/nodes_guardrail_v1"
        },
        {
          "$ref": "#/$defs/nodes_evaluate_v1"
        },
        {
          "$ref": "#/$defs/nodes_error_v1"
        },
        {
          "$ref": "#/$defs/nodes_review_v1"
        },
        {
          "$ref": "#/$defs/nodes_file_input_v1"
        },
        {
          "$ref": "#/$defs/nodes_document_extract_v1"
        },
        {
          "$ref": "#/$defs/nodes_file_output_v1"
        },
        {
          "$ref": "#/$defs/nodes_parallel_v1"
        },
        {
          "$ref": "#/$defs/nodes_agent_team_v1"
        },
        {
          "$ref": "#/$defs/nodes_orchestrator_v1"
        },
        {
          "$ref": "#/$defs/nodes_subworkflow_v1"
        },
        {
          "$ref": "#/$defs/nodes_loop_v1"
        }
      ]
    },
    "nodes_agent_v1": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "type": {
          "const": "agent"
        },
        "typeVersion": {
          "const": 1
        },
        "label": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "description": {
          "type": "string",
          "maxLength": 2000
        },
        "inputBindings": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/binding"
          }
        },
        "config": {
          "type": "object",
          "properties": {
            "modelProfile": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            },
            "instructions": {
              "type": "string"
            },
            "toolAllowlist": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/tool_ref"
              },
              "minItems": 0
            },
            "maxSteps": {
              "type": "integer",
              "minimum": 1,
              "maximum": 100
            },
            "resultSchema": {
              "$ref": "#/$defs/user_schema"
            },
            "strategy": {
              "type": "string",
              "enum": [
                "task",
                "agentic_rag"
              ]
            },
            "retrievalPolicy": {
              "type": "object",
              "properties": {
                "maxRounds": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 20
                },
                "maxQueriesPerRound": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 20
                },
                "maxRetrievedChunks": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 1000
                },
                "maxContextTokens": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 200000
                },
                "onInsufficient": {
                  "type": "string",
                  "enum": [
                    "abstain",
                    "ask"
                  ]
                },
                "clarificationFlowRef": {
                  "$ref": "#/$defs/flow_ref"
                }
              },
              "required": [
                "maxRounds",
                "maxQueriesPerRound",
                "maxRetrievedChunks",
                "maxContextTokens",
                "onInsufficient"
              ],
              "additionalProperties": false
            }
          },
          "required": [
            "modelProfile",
            "instructions",
            "toolAllowlist",
            "maxSteps",
            "resultSchema",
            "strategy"
          ],
          "additionalProperties": false,
          "allOf": [
            {
              "if": {
                "properties": {
                  "strategy": {
                    "const": "agentic_rag"
                  }
                },
                "type": "object"
              },
              "then": {
                "required": [
                  "retrievalPolicy"
                ],
                "type": "object",
                "properties": {
                  "retrievalPolicy": {}
                }
              }
            }
          ]
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/attachment"
          },
          "minItems": 0
        },
        "execution": {
          "$ref": "#/$defs/execution"
        }
      },
      "required": [
        "id",
        "type",
        "typeVersion",
        "label",
        "inputBindings",
        "config",
        "attachments",
        "execution"
      ],
      "additionalProperties": false,
      "title": "AgentNode"
    },
    "nodes_agent_team_v1": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "type": {
          "const": "agent_team"
        },
        "typeVersion": {
          "const": 1
        },
        "label": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "description": {
          "type": "string",
          "maxLength": 2000
        },
        "inputBindings": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/binding"
          }
        },
        "config": {
          "type": "object",
          "properties": {
            "members": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
                  },
                  "role": {
                    "type": "string"
                  },
                  "flowRef": {
                    "$ref": "#/$defs/flow_ref"
                  }
                },
                "required": [
                  "id",
                  "role",
                  "flowRef"
                ],
                "additionalProperties": false
              },
              "minItems": 1
            },
            "mode": {
              "type": "string",
              "enum": [
                "sequential",
                "parallel"
              ]
            },
            "maxConcurrency": {
              "type": "integer",
              "minimum": 1,
              "maximum": 32
            },
            "integrationFlowRef": {
              "$ref": "#/$defs/flow_ref"
            }
          },
          "required": [
            "members",
            "mode",
            "maxConcurrency"
          ],
          "additionalProperties": false
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/attachment"
          },
          "minItems": 0
        },
        "execution": {
          "$ref": "#/$defs/execution"
        }
      },
      "required": [
        "id",
        "type",
        "typeVersion",
        "label",
        "inputBindings",
        "config",
        "attachments",
        "execution"
      ],
      "additionalProperties": false,
      "title": "AgentTeamNode"
    },
    "nodes_ai_v1": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "type": {
          "const": "ai"
        },
        "typeVersion": {
          "const": 1
        },
        "label": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "description": {
          "type": "string",
          "maxLength": 2000
        },
        "inputBindings": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/binding"
          }
        },
        "config": {
          "type": "object",
          "properties": {
            "modelProfile": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            },
            "instructions": {
              "type": "string"
            },
            "responseFormat": {
              "oneOf": [
                {
                  "type": "object",
                  "properties": {
                    "mode": {
                      "const": "text"
                    }
                  },
                  "required": [
                    "mode"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "mode": {
                      "const": "json"
                    },
                    "schema": {
                      "$ref": "#/$defs/user_schema"
                    }
                  },
                  "required": [
                    "mode",
                    "schema"
                  ],
                  "additionalProperties": false
                }
              ]
            },
            "maxOutputTokens": {
              "type": "integer",
              "minimum": 1,
              "maximum": 131072
            }
          },
          "required": [
            "modelProfile",
            "instructions",
            "responseFormat",
            "maxOutputTokens"
          ],
          "additionalProperties": false
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/attachment"
          },
          "minItems": 0
        },
        "execution": {
          "$ref": "#/$defs/execution"
        }
      },
      "required": [
        "id",
        "type",
        "typeVersion",
        "label",
        "inputBindings",
        "config",
        "attachments",
        "execution"
      ],
      "additionalProperties": false,
      "title": "AiNode"
    },
    "nodes_candidate_search_v1": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "type": {
          "const": "candidate_search"
        },
        "typeVersion": {
          "const": 1
        },
        "label": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "description": {
          "type": "string",
          "maxLength": 2000
        },
        "inputBindings": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/binding"
          }
        },
        "config": {
          "type": "object",
          "properties": {
            "mode": {
              "type": "string",
              "enum": [
                "tree",
                "graph"
              ]
            },
            "generatorFlowRef": {
              "$ref": "#/$defs/flow_ref"
            },
            "verifierId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            },
            "maxCandidates": {
              "type": "integer",
              "minimum": 1,
              "maximum": 1000
            },
            "maxDepth": {
              "type": "integer",
              "minimum": 1,
              "maximum": 20
            },
            "maxVerifications": {
              "type": "integer",
              "minimum": 1,
              "maximum": 1000
            }
          },
          "required": [
            "mode",
            "generatorFlowRef",
            "verifierId",
            "maxCandidates",
            "maxDepth",
            "maxVerifications"
          ],
          "additionalProperties": false
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/attachment"
          },
          "minItems": 0
        },
        "execution": {
          "$ref": "#/$defs/execution"
        }
      },
      "required": [
        "id",
        "type",
        "typeVersion",
        "label",
        "inputBindings",
        "config",
        "attachments",
        "execution"
      ],
      "additionalProperties": false,
      "title": "CandidateSearchNode"
    },
    "nodes_classify_v1": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "type": {
          "const": "classify"
        },
        "typeVersion": {
          "const": 1
        },
        "label": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "description": {
          "type": "string",
          "maxLength": 2000
        },
        "inputBindings": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/binding"
          }
        },
        "config": {
          "type": "object",
          "properties": {
            "modelProfile": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            },
            "labels": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
                  },
                  "description": {
                    "type": "string"
                  }
                },
                "required": [
                  "id",
                  "description"
                ],
                "additionalProperties": false
              },
              "minItems": 1
            },
            "onUncertain": {
              "const": "unclassified"
            }
          },
          "required": [
            "modelProfile",
            "labels",
            "onUncertain"
          ],
          "additionalProperties": false
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/attachment"
          },
          "minItems": 0
        },
        "execution": {
          "$ref": "#/$defs/execution"
        }
      },
      "required": [
        "id",
        "type",
        "typeVersion",
        "label",
        "inputBindings",
        "config",
        "attachments",
        "execution"
      ],
      "additionalProperties": false,
      "title": "ClassifyNode"
    },
    "nodes_compensate_v1": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "type": {
          "const": "compensate"
        },
        "typeVersion": {
          "const": 1
        },
        "label": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "description": {
          "type": "string",
          "maxLength": 2000
        },
        "inputBindings": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/binding"
          }
        },
        "config": {
          "type": "object",
          "properties": {
            "method": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            }
          },
          "required": [
            "method"
          ],
          "additionalProperties": false
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/attachment"
          },
          "minItems": 0
        },
        "execution": {
          "$ref": "#/$defs/execution"
        }
      },
      "required": [
        "id",
        "type",
        "typeVersion",
        "label",
        "inputBindings",
        "config",
        "attachments",
        "execution"
      ],
      "additionalProperties": false,
      "title": "CompensateNode"
    },
    "nodes_condition_v1": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "type": {
          "const": "condition"
        },
        "typeVersion": {
          "const": 1
        },
        "label": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "description": {
          "type": "string",
          "maxLength": 2000
        },
        "inputBindings": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/binding"
          }
        },
        "config": {
          "type": "object",
          "properties": {
            "expression": {
              "$ref": "#/$defs/expression"
            }
          },
          "required": [
            "expression"
          ],
          "additionalProperties": false
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/attachment"
          },
          "minItems": 0
        },
        "execution": {
          "$ref": "#/$defs/execution"
        }
      },
      "required": [
        "id",
        "type",
        "typeVersion",
        "label",
        "inputBindings",
        "config",
        "attachments",
        "execution"
      ],
      "additionalProperties": false,
      "title": "ConditionNode"
    },
    "nodes_document_extract_v1": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "type": {
          "const": "document_extract"
        },
        "typeVersion": {
          "const": 1
        },
        "label": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "description": {
          "type": "string",
          "maxLength": 2000
        },
        "inputBindings": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/binding"
          }
        },
        "config": {
          "type": "object",
          "properties": {
            "mode": {
              "type": "string",
              "enum": [
                "text",
                "table",
                "ocr"
              ]
            },
            "languages": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "minItems": 0
            },
            "workerProfile": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            }
          },
          "required": [
            "mode"
          ],
          "additionalProperties": false
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/attachment"
          },
          "minItems": 0
        },
        "execution": {
          "$ref": "#/$defs/execution"
        }
      },
      "required": [
        "id",
        "type",
        "typeVersion",
        "label",
        "inputBindings",
        "config",
        "attachments",
        "execution"
      ],
      "additionalProperties": false,
      "title": "DocumentExtractNode"
    },
    "nodes_error_v1": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "type": {
          "const": "error"
        },
        "typeVersion": {
          "const": 1
        },
        "label": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "description": {
          "type": "string",
          "maxLength": 2000
        },
        "inputBindings": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/binding"
          }
        },
        "config": {
          "type": "object",
          "properties": {
            "mode": {
              "type": "string",
              "enum": [
                "recover",
                "rethrow"
              ]
            }
          },
          "required": [
            "mode"
          ],
          "additionalProperties": false
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/attachment"
          },
          "minItems": 0
        },
        "execution": {
          "$ref": "#/$defs/execution"
        }
      },
      "required": [
        "id",
        "type",
        "typeVersion",
        "label",
        "inputBindings",
        "config",
        "attachments",
        "execution"
      ],
      "additionalProperties": false,
      "title": "ErrorNode"
    },
    "nodes_evaluate_v1": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "type": {
          "const": "evaluate"
        },
        "typeVersion": {
          "const": 1
        },
        "label": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "description": {
          "type": "string",
          "maxLength": 2000
        },
        "inputBindings": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/binding"
          }
        },
        "config": {
          "type": "object",
          "properties": {
            "mode": {
              "type": "string",
              "enum": [
                "rules",
                "model"
              ]
            },
            "resultSchema": {
              "$ref": "#/$defs/user_schema"
            },
            "passRule": {
              "$ref": "#/$defs/expression"
            },
            "modelProfile": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            },
            "instructions": {
              "type": "string"
            },
            "rules": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
                  },
                  "expression": {
                    "$ref": "#/$defs/expression"
                  }
                },
                "required": [
                  "id",
                  "expression"
                ],
                "additionalProperties": false
              },
              "minItems": 0
            }
          },
          "required": [
            "mode",
            "resultSchema",
            "passRule"
          ],
          "additionalProperties": false,
          "allOf": [
            {
              "if": {
                "properties": {
                  "mode": {
                    "const": "model"
                  }
                },
                "type": "object"
              },
              "then": {
                "required": [
                  "modelProfile",
                  "instructions"
                ],
                "type": "object",
                "properties": {
                  "modelProfile": {},
                  "instructions": {}
                }
              }
            },
            {
              "if": {
                "properties": {
                  "mode": {
                    "const": "rules"
                  }
                },
                "type": "object"
              },
              "then": {
                "required": [
                  "rules"
                ],
                "type": "object",
                "properties": {
                  "rules": {}
                }
              }
            }
          ]
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/attachment"
          },
          "minItems": 0
        },
        "execution": {
          "$ref": "#/$defs/execution"
        }
      },
      "required": [
        "id",
        "type",
        "typeVersion",
        "label",
        "inputBindings",
        "config",
        "attachments",
        "execution"
      ],
      "additionalProperties": false,
      "title": "EvaluateNode"
    },
    "nodes_file_input_v1": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "type": {
          "const": "file_input"
        },
        "typeVersion": {
          "const": 1
        },
        "label": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "description": {
          "type": "string",
          "maxLength": 2000
        },
        "inputBindings": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/binding"
          }
        },
        "config": {
          "type": "object",
          "properties": {
            "mimeTypes": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "minItems": 1
            },
            "maxFiles": {
              "type": "integer",
              "minimum": 1,
              "maximum": 1000
            },
            "maxBytesPerFile": {
              "type": "integer",
              "minimum": 1,
              "maximum": 134217728
            }
          },
          "required": [
            "mimeTypes",
            "maxFiles",
            "maxBytesPerFile"
          ],
          "additionalProperties": false
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/attachment"
          },
          "minItems": 0
        },
        "execution": {
          "$ref": "#/$defs/execution"
        }
      },
      "required": [
        "id",
        "type",
        "typeVersion",
        "label",
        "inputBindings",
        "config",
        "attachments",
        "execution"
      ],
      "additionalProperties": false,
      "title": "FileInputNode"
    },
    "nodes_file_output_v1": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "type": {
          "const": "file_output"
        },
        "typeVersion": {
          "const": 1
        },
        "label": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "description": {
          "type": "string",
          "maxLength": 2000
        },
        "inputBindings": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/binding"
          }
        },
        "config": {
          "type": "object",
          "properties": {
            "format": {
              "type": "string",
              "enum": [
                "text",
                "markdown",
                "json",
                "csv",
                "html",
                "docx",
                "pdf",
                "copy"
              ]
            },
            "filename": {
              "type": "string"
            },
            "outputDirectory": {
              "type": "string"
            },
            "workerProfile": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            }
          },
          "required": [
            "format",
            "filename",
            "outputDirectory"
          ],
          "additionalProperties": false
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/attachment"
          },
          "minItems": 0
        },
        "execution": {
          "$ref": "#/$defs/execution"
        }
      },
      "required": [
        "id",
        "type",
        "typeVersion",
        "label",
        "inputBindings",
        "config",
        "attachments",
        "execution"
      ],
      "additionalProperties": false,
      "title": "FileOutputNode"
    },
    "nodes_form_v1": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "type": {
          "const": "form"
        },
        "typeVersion": {
          "const": 1
        },
        "label": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "description": {
          "type": "string",
          "maxLength": 2000
        },
        "inputBindings": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/binding"
          }
        },
        "config": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "mode": {
                  "const": "initial"
                },
                "title": {
                  "type": "string"
                }
              },
              "required": [
                "mode",
                "title"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "mode": {
                  "const": "request"
                },
                "title": {
                  "type": "string"
                },
                "schema": {
                  "$ref": "#/$defs/user_schema"
                }
              },
              "required": [
                "mode",
                "title",
                "schema"
              ],
              "additionalProperties": false
            }
          ]
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/attachment"
          },
          "minItems": 0
        },
        "execution": {
          "$ref": "#/$defs/execution"
        }
      },
      "required": [
        "id",
        "type",
        "typeVersion",
        "label",
        "inputBindings",
        "config",
        "attachments",
        "execution"
      ],
      "additionalProperties": false,
      "title": "FormNode"
    },
    "nodes_guardrail_v1": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "type": {
          "const": "guardrail"
        },
        "typeVersion": {
          "const": 1
        },
        "label": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "description": {
          "type": "string",
          "maxLength": 2000
        },
        "inputBindings": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/binding"
          }
        },
        "config": {
          "type": "object",
          "properties": {
            "rules": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
                  },
                  "kind": {
                    "type": "string",
                    "enum": [
                      "schema",
                      "length",
                      "allowed_values",
                      "required_fields"
                    ]
                  },
                  "parameters": {
                    "type": "object",
                    "additionalProperties": {
                      "$ref": "#/$defs/json_value"
                    }
                  }
                },
                "required": [
                  "id",
                  "kind",
                  "parameters"
                ],
                "additionalProperties": false
              },
              "minItems": 1
            },
            "onViolation": {
              "const": "block"
            }
          },
          "required": [
            "rules",
            "onViolation"
          ],
          "additionalProperties": false
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/attachment"
          },
          "minItems": 0
        },
        "execution": {
          "$ref": "#/$defs/execution"
        }
      },
      "required": [
        "id",
        "type",
        "typeVersion",
        "label",
        "inputBindings",
        "config",
        "attachments",
        "execution"
      ],
      "additionalProperties": false,
      "title": "GuardrailNode"
    },
    "nodes_input_v1": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "type": {
          "const": "input"
        },
        "typeVersion": {
          "const": 1
        },
        "label": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "description": {
          "type": "string",
          "maxLength": 2000
        },
        "inputBindings": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/binding"
          }
        },
        "config": {
          "type": "object",
          "properties": {},
          "required": [],
          "additionalProperties": false
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/attachment"
          },
          "minItems": 0
        },
        "execution": {
          "$ref": "#/$defs/execution"
        }
      },
      "required": [
        "id",
        "type",
        "typeVersion",
        "label",
        "inputBindings",
        "config",
        "attachments",
        "execution"
      ],
      "additionalProperties": false,
      "title": "InputNode"
    },
    "nodes_knowledge_v1": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "type": {
          "const": "knowledge"
        },
        "typeVersion": {
          "const": 1
        },
        "label": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "description": {
          "type": "string",
          "maxLength": 2000
        },
        "inputBindings": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/binding"
          }
        },
        "config": {
          "type": "object",
          "properties": {
            "operation": {
              "type": "string",
              "enum": [
                "build",
                "update",
                "open",
                "delete"
              ]
            },
            "profile": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            },
            "indexSettings": {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "enum": [
                    "keyword",
                    "vector",
                    "hybrid",
                    "graph"
                  ]
                },
                "chunkSize": {
                  "type": "integer",
                  "minimum": 100,
                  "maximum": 20000
                },
                "chunkOverlap": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 10000
                },
                "embeddingProfile": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
                },
                "graphExtractionProfile": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
                },
                "graphSummaryProfile": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
                },
                "entityTypes": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  },
                  "minItems": 0
                },
                "relationTypes": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  },
                  "minItems": 0
                }
              },
              "required": [
                "kind",
                "chunkSize",
                "chunkOverlap"
              ],
              "additionalProperties": false
            }
          },
          "required": [
            "operation"
          ],
          "additionalProperties": false,
          "allOf": [
            {
              "if": {
                "properties": {
                  "operation": {
                    "enum": [
                      "build",
                      "update"
                    ]
                  }
                },
                "type": "object"
              },
              "then": {
                "required": [
                  "profile",
                  "indexSettings"
                ],
                "type": "object",
                "properties": {
                  "profile": {},
                  "indexSettings": {}
                }
              }
            }
          ]
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/attachment"
          },
          "minItems": 0
        },
        "execution": {
          "$ref": "#/$defs/execution"
        }
      },
      "required": [
        "id",
        "type",
        "typeVersion",
        "label",
        "inputBindings",
        "config",
        "attachments",
        "execution"
      ],
      "additionalProperties": false,
      "title": "KnowledgeNode"
    },
    "nodes_loop_v1": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "type": {
          "const": "loop"
        },
        "typeVersion": {
          "const": 1
        },
        "label": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "description": {
          "type": "string",
          "maxLength": 2000
        },
        "inputBindings": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/binding"
          }
        },
        "config": {
          "type": "object",
          "properties": {
            "mode": {
              "type": "string",
              "enum": [
                "foreach",
                "until"
              ]
            },
            "bodyFlowRef": {
              "$ref": "#/$defs/flow_ref"
            },
            "maxIterations": {
              "type": "integer",
              "minimum": 1,
              "maximum": 1000
            },
            "untilExpression": {
              "$ref": "#/$defs/expression"
            }
          },
          "required": [
            "mode",
            "bodyFlowRef",
            "maxIterations"
          ],
          "additionalProperties": false,
          "allOf": [
            {
              "if": {
                "properties": {
                  "mode": {
                    "const": "until"
                  }
                },
                "type": "object"
              },
              "then": {
                "required": [
                  "untilExpression"
                ],
                "type": "object",
                "properties": {
                  "untilExpression": {}
                }
              }
            }
          ]
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/attachment"
          },
          "minItems": 0
        },
        "execution": {
          "$ref": "#/$defs/execution"
        }
      },
      "required": [
        "id",
        "type",
        "typeVersion",
        "label",
        "inputBindings",
        "config",
        "attachments",
        "execution"
      ],
      "additionalProperties": false,
      "title": "LoopNode"
    },
    "nodes_memory_v1": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "type": {
          "const": "memory"
        },
        "typeVersion": {
          "const": 1
        },
        "label": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "description": {
          "type": "string",
          "maxLength": 2000
        },
        "inputBindings": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/binding"
          }
        },
        "config": {
          "type": "object",
          "properties": {
            "operation": {
              "type": "string",
              "enum": [
                "get",
                "put",
                "delete"
              ]
            },
            "scope": {
              "type": "string",
              "enum": [
                "run",
                "project"
              ]
            },
            "ttlMs": {
              "type": "integer",
              "minimum": 1
            }
          },
          "required": [
            "operation",
            "scope"
          ],
          "additionalProperties": false
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/attachment"
          },
          "minItems": 0
        },
        "execution": {
          "$ref": "#/$defs/execution"
        }
      },
      "required": [
        "id",
        "type",
        "typeVersion",
        "label",
        "inputBindings",
        "config",
        "attachments",
        "execution"
      ],
      "additionalProperties": false,
      "title": "MemoryNode"
    },
    "nodes_merge_v1": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "type": {
          "const": "merge"
        },
        "typeVersion": {
          "const": 1
        },
        "label": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "description": {
          "type": "string",
          "maxLength": 2000
        },
        "inputBindings": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/binding"
          }
        },
        "config": {
          "type": "object",
          "properties": {
            "waitFor": {
              "const": "all_active"
            },
            "combine": {
              "type": "string",
              "enum": [
                "object",
                "array",
                "select"
              ]
            },
            "collision": {
              "type": "string",
              "enum": [
                "error",
                "namespace"
              ]
            },
            "selectKey": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            }
          },
          "required": [
            "waitFor",
            "combine",
            "collision"
          ],
          "additionalProperties": false
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/attachment"
          },
          "minItems": 0
        },
        "execution": {
          "$ref": "#/$defs/execution"
        }
      },
      "required": [
        "id",
        "type",
        "typeVersion",
        "label",
        "inputBindings",
        "config",
        "attachments",
        "execution"
      ],
      "additionalProperties": false,
      "title": "MergeNode"
    },
    "nodes_orchestrator_v1": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "type": {
          "const": "orchestrator"
        },
        "typeVersion": {
          "const": 1
        },
        "label": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "description": {
          "type": "string",
          "maxLength": 2000
        },
        "inputBindings": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/binding"
          }
        },
        "config": {
          "type": "object",
          "properties": {
            "mode": {
              "type": "string",
              "enum": [
                "plan",
                "adaptive",
                "dynamic"
              ]
            },
            "allowedFlows": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/flow_ref"
              },
              "minItems": 1
            },
            "modelProfile": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            },
            "maxReplans": {
              "type": "integer",
              "minimum": 0,
              "maximum": 20
            },
            "maxTasks": {
              "type": "integer",
              "minimum": 1,
              "maximum": 1000
            }
          },
          "required": [
            "mode",
            "allowedFlows",
            "modelProfile",
            "maxReplans",
            "maxTasks"
          ],
          "additionalProperties": false
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/attachment"
          },
          "minItems": 0
        },
        "execution": {
          "$ref": "#/$defs/execution"
        }
      },
      "required": [
        "id",
        "type",
        "typeVersion",
        "label",
        "inputBindings",
        "config",
        "attachments",
        "execution"
      ],
      "additionalProperties": false,
      "title": "OrchestratorNode"
    },
    "nodes_output_v1": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "type": {
          "const": "output"
        },
        "typeVersion": {
          "const": 1
        },
        "label": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "description": {
          "type": "string",
          "maxLength": 2000
        },
        "inputBindings": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/binding"
          }
        },
        "config": {
          "type": "object",
          "properties": {
            "format": {
              "type": "string",
              "enum": [
                "text",
                "json",
                "files"
              ]
            }
          },
          "required": [
            "format"
          ],
          "additionalProperties": false
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/attachment"
          },
          "minItems": 0
        },
        "execution": {
          "$ref": "#/$defs/execution"
        }
      },
      "required": [
        "id",
        "type",
        "typeVersion",
        "label",
        "inputBindings",
        "config",
        "attachments",
        "execution"
      ],
      "additionalProperties": false,
      "title": "OutputNode"
    },
    "nodes_parallel_v1": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "type": {
          "const": "parallel"
        },
        "typeVersion": {
          "const": 1
        },
        "label": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "description": {
          "type": "string",
          "maxLength": 2000
        },
        "inputBindings": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/binding"
          }
        },
        "config": {
          "type": "object",
          "properties": {
            "branches": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
                  },
                  "flowRef": {
                    "$ref": "#/$defs/flow_ref"
                  }
                },
                "required": [
                  "id",
                  "flowRef"
                ],
                "additionalProperties": false
              },
              "minItems": 1
            },
            "mode": {
              "type": "string",
              "enum": [
                "all",
                "first_match"
              ]
            },
            "maxConcurrency": {
              "type": "integer",
              "minimum": 1,
              "maximum": 32
            },
            "failurePolicy": {
              "type": "string",
              "enum": [
                "fail_fast",
                "collect"
              ]
            },
            "matchExpression": {
              "$ref": "#/$defs/expression"
            }
          },
          "required": [
            "branches",
            "mode",
            "maxConcurrency",
            "failurePolicy"
          ],
          "additionalProperties": false,
          "allOf": [
            {
              "if": {
                "properties": {
                  "mode": {
                    "const": "first_match"
                  }
                },
                "type": "object"
              },
              "then": {
                "required": [
                  "matchExpression"
                ],
                "type": "object",
                "properties": {
                  "matchExpression": {}
                }
              }
            }
          ]
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/attachment"
          },
          "minItems": 0
        },
        "execution": {
          "$ref": "#/$defs/execution"
        }
      },
      "required": [
        "id",
        "type",
        "typeVersion",
        "label",
        "inputBindings",
        "config",
        "attachments",
        "execution"
      ],
      "additionalProperties": false,
      "title": "ParallelNode"
    },
    "nodes_program_v1": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "type": {
          "const": "program"
        },
        "typeVersion": {
          "const": 1
        },
        "label": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "description": {
          "type": "string",
          "maxLength": 2000
        },
        "inputBindings": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/binding"
          }
        },
        "config": {
          "type": "object",
          "properties": {
            "codeRef": {
              "type": "object",
              "properties": {
                "resource": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
                },
                "path": {
                  "type": "string"
                }
              },
              "required": [
                "resource",
                "path"
              ],
              "additionalProperties": false
            },
            "workerProfile": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            },
            "resultSchema": {
              "$ref": "#/$defs/user_schema"
            }
          },
          "required": [
            "codeRef",
            "workerProfile",
            "resultSchema"
          ],
          "additionalProperties": false
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/attachment"
          },
          "minItems": 0
        },
        "execution": {
          "$ref": "#/$defs/execution"
        }
      },
      "required": [
        "id",
        "type",
        "typeVersion",
        "label",
        "inputBindings",
        "config",
        "attachments",
        "execution"
      ],
      "additionalProperties": false,
      "title": "ProgramNode"
    },
    "nodes_resource_v1": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "type": {
          "const": "resource"
        },
        "typeVersion": {
          "const": 1
        },
        "label": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "description": {
          "type": "string",
          "maxLength": 2000
        },
        "inputBindings": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/binding"
          }
        },
        "config": {
          "type": "object",
          "properties": {
            "resource": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            },
            "pointer": {
              "type": "string"
            }
          },
          "required": [
            "resource"
          ],
          "additionalProperties": false
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/attachment"
          },
          "minItems": 0
        },
        "execution": {
          "$ref": "#/$defs/execution"
        }
      },
      "required": [
        "id",
        "type",
        "typeVersion",
        "label",
        "inputBindings",
        "config",
        "attachments",
        "execution"
      ],
      "additionalProperties": false,
      "title": "ResourceNode"
    },
    "nodes_retrieval_v1": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "type": {
          "const": "retrieval"
        },
        "typeVersion": {
          "const": 1
        },
        "label": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "description": {
          "type": "string",
          "maxLength": 2000
        },
        "inputBindings": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/binding"
          }
        },
        "config": {
          "type": "object",
          "properties": {
            "mode": {
              "type": "string",
              "enum": [
                "keyword",
                "vector",
                "web",
                "hybrid",
                "graph_local",
                "graph_global"
              ]
            },
            "topK": {
              "type": "integer",
              "minimum": 1,
              "maximum": 100
            },
            "maxContextTokens": {
              "type": "integer",
              "minimum": 1,
              "maximum": 200000
            },
            "keywordTopK": {
              "type": "integer",
              "minimum": 1,
              "maximum": 1000
            },
            "vectorTopK": {
              "type": "integer",
              "minimum": 1,
              "maximum": 1000
            },
            "candidateLimit": {
              "type": "integer",
              "minimum": 1,
              "maximum": 1000
            },
            "fusion": {
              "type": "object",
              "properties": {
                "method": {
                  "const": "rrf"
                },
                "k": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 1000
                }
              },
              "required": [
                "method",
                "k"
              ],
              "additionalProperties": false
            },
            "reranker": {
              "type": "object",
              "properties": {
                "modelProfile": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
                },
                "timeoutMs": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 120000
                },
                "onFailure": {
                  "type": "string",
                  "enum": [
                    "fail",
                    "use_original"
                  ]
                }
              },
              "required": [
                "modelProfile",
                "timeoutMs",
                "onFailure"
              ],
              "additionalProperties": false
            },
            "allowedOrigins": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "minItems": 0
            },
            "maxHops": {
              "type": "integer",
              "minimum": 1,
              "maximum": 10
            },
            "maxCommunities": {
              "type": "integer",
              "minimum": 1,
              "maximum": 100
            },
            "communityLevel": {
              "type": "integer",
              "minimum": 0,
              "maximum": 20
            }
          },
          "required": [
            "mode",
            "topK",
            "maxContextTokens"
          ],
          "additionalProperties": false,
          "allOf": [
            {
              "if": {
                "properties": {
                  "mode": {
                    "const": "hybrid"
                  }
                },
                "type": "object"
              },
              "then": {
                "required": [
                  "keywordTopK",
                  "vectorTopK",
                  "candidateLimit",
                  "fusion"
                ],
                "type": "object",
                "properties": {
                  "keywordTopK": {},
                  "vectorTopK": {},
                  "candidateLimit": {},
                  "fusion": {}
                }
              }
            },
            {
              "if": {
                "properties": {
                  "mode": {
                    "const": "web"
                  }
                },
                "type": "object"
              },
              "then": {
                "required": [
                  "allowedOrigins"
                ],
                "type": "object",
                "properties": {
                  "allowedOrigins": {}
                }
              }
            },
            {
              "if": {
                "properties": {
                  "mode": {
                    "const": "graph_local"
                  }
                },
                "type": "object"
              },
              "then": {
                "required": [
                  "maxHops"
                ],
                "type": "object",
                "properties": {
                  "maxHops": {}
                }
              }
            },
            {
              "if": {
                "properties": {
                  "mode": {
                    "const": "graph_global"
                  }
                },
                "type": "object"
              },
              "then": {
                "required": [
                  "maxCommunities",
                  "communityLevel"
                ],
                "type": "object",
                "properties": {
                  "maxCommunities": {},
                  "communityLevel": {}
                }
              }
            }
          ]
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/attachment"
          },
          "minItems": 0
        },
        "execution": {
          "$ref": "#/$defs/execution"
        }
      },
      "required": [
        "id",
        "type",
        "typeVersion",
        "label",
        "inputBindings",
        "config",
        "attachments",
        "execution"
      ],
      "additionalProperties": false,
      "title": "RetrievalNode"
    },
    "nodes_review_v1": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "type": {
          "const": "review"
        },
        "typeVersion": {
          "const": 1
        },
        "label": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "description": {
          "type": "string",
          "maxLength": 2000
        },
        "inputBindings": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/binding"
          }
        },
        "config": {
          "type": "object",
          "properties": {
            "question": {
              "type": "string"
            },
            "responseSchema": {
              "$ref": "#/$defs/user_schema"
            }
          },
          "required": [
            "question",
            "responseSchema"
          ],
          "additionalProperties": false
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/attachment"
          },
          "minItems": 0
        },
        "execution": {
          "$ref": "#/$defs/execution"
        }
      },
      "required": [
        "id",
        "type",
        "typeVersion",
        "label",
        "inputBindings",
        "config",
        "attachments",
        "execution"
      ],
      "additionalProperties": false,
      "title": "ReviewNode"
    },
    "nodes_skill_v1": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "type": {
          "const": "skill"
        },
        "typeVersion": {
          "const": 1
        },
        "label": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "description": {
          "type": "string",
          "maxLength": 2000
        },
        "inputBindings": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/binding"
          }
        },
        "config": {
          "type": "object",
          "properties": {
            "resource": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            },
            "mode": {
              "type": "string",
              "enum": [
                "instructions",
                "execute"
              ]
            },
            "entrypoint": {
              "type": "string"
            },
            "workerProfile": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            },
            "resultSchema": {
              "$ref": "#/$defs/user_schema"
            }
          },
          "required": [
            "resource",
            "mode"
          ],
          "additionalProperties": false,
          "allOf": [
            {
              "if": {
                "properties": {
                  "mode": {
                    "const": "execute"
                  }
                },
                "type": "object"
              },
              "then": {
                "required": [
                  "entrypoint",
                  "workerProfile",
                  "resultSchema"
                ],
                "type": "object",
                "properties": {
                  "entrypoint": {},
                  "workerProfile": {},
                  "resultSchema": {}
                }
              }
            }
          ]
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/attachment"
          },
          "minItems": 0
        },
        "execution": {
          "$ref": "#/$defs/execution"
        }
      },
      "required": [
        "id",
        "type",
        "typeVersion",
        "label",
        "inputBindings",
        "config",
        "attachments",
        "execution"
      ],
      "additionalProperties": false,
      "title": "SkillNode"
    },
    "nodes_subworkflow_v1": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "type": {
          "const": "subworkflow"
        },
        "typeVersion": {
          "const": 1
        },
        "label": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "description": {
          "type": "string",
          "maxLength": 2000
        },
        "inputBindings": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/binding"
          }
        },
        "config": {
          "type": "object",
          "properties": {
            "flowRef": {
              "$ref": "#/$defs/flow_ref"
            }
          },
          "required": [
            "flowRef"
          ],
          "additionalProperties": false
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/attachment"
          },
          "minItems": 0
        },
        "execution": {
          "$ref": "#/$defs/execution"
        }
      },
      "required": [
        "id",
        "type",
        "typeVersion",
        "label",
        "inputBindings",
        "config",
        "attachments",
        "execution"
      ],
      "additionalProperties": false,
      "title": "SubworkflowNode"
    },
    "nodes_tool_v1": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "type": {
          "const": "tool"
        },
        "typeVersion": {
          "const": 1
        },
        "label": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "description": {
          "type": "string",
          "maxLength": 2000
        },
        "inputBindings": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/binding"
          }
        },
        "config": {
          "type": "object",
          "properties": {
            "tool": {
              "$ref": "#/$defs/tool_ref"
            }
          },
          "required": [
            "tool"
          ],
          "additionalProperties": false
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/attachment"
          },
          "minItems": 0
        },
        "execution": {
          "$ref": "#/$defs/execution"
        }
      },
      "required": [
        "id",
        "type",
        "typeVersion",
        "label",
        "inputBindings",
        "config",
        "attachments",
        "execution"
      ],
      "additionalProperties": false,
      "title": "ToolNode"
    },
    "nodes_transform_v1": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "type": {
          "const": "transform"
        },
        "typeVersion": {
          "const": 1
        },
        "label": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "description": {
          "type": "string",
          "maxLength": 2000
        },
        "inputBindings": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/binding"
          }
        },
        "config": {
          "type": "object",
          "properties": {
            "steps": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "op": {
                    "type": "string",
                    "enum": [
                      "pick",
                      "omit",
                      "rename",
                      "map",
                      "format",
                      "parse_json",
                      "stringify_json"
                    ]
                  },
                  "options": {
                    "type": "object",
                    "additionalProperties": {
                      "$ref": "#/$defs/json_value"
                    }
                  }
                },
                "required": [
                  "op"
                ],
                "additionalProperties": false
              },
              "minItems": 1
            },
            "resultSchema": {
              "$ref": "#/$defs/user_schema"
            }
          },
          "required": [
            "steps",
            "resultSchema"
          ],
          "additionalProperties": false
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/attachment"
          },
          "minItems": 0
        },
        "execution": {
          "$ref": "#/$defs/execution"
        }
      },
      "required": [
        "id",
        "type",
        "typeVersion",
        "label",
        "inputBindings",
        "config",
        "attachments",
        "execution"
      ],
      "additionalProperties": false,
      "title": "TransformNode"
    },
    "nodes_trigger_v1": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "type": {
          "const": "trigger"
        },
        "typeVersion": {
          "const": 1
        },
        "label": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "description": {
          "type": "string",
          "maxLength": 2000
        },
        "inputBindings": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/binding"
          }
        },
        "config": {
          "type": "object",
          "properties": {
            "kind": {
              "const": "schedule"
            },
            "cron": {
              "type": "string"
            },
            "timeZone": {
              "type": "string"
            },
            "misfire": {
              "type": "string",
              "enum": [
                "skip",
                "run_once"
              ]
            },
            "overlap": {
              "type": "string",
              "enum": [
                "skip",
                "queue_one"
              ]
            }
          },
          "required": [
            "kind",
            "cron",
            "timeZone",
            "misfire",
            "overlap"
          ],
          "additionalProperties": false
        },
        "attachments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/attachment"
          },
          "minItems": 0
        },
        "execution": {
          "$ref": "#/$defs/execution"
        }
      },
      "required": [
        "id",
        "type",
        "typeVersion",
        "label",
        "inputBindings",
        "config",
        "attachments",
        "execution"
      ],
      "additionalProperties": false,
      "title": "TriggerNode"
    },
    "official_example": {
      "title": "OfficialExample",
      "$comment": "A planned catalogue entry is a production brief, never evidence of usable content. Release status is derived by the catalogue gate.",
      "type": "object",
      "additionalProperties": false,
      "required": [
        "schemaVersion",
        "id",
        "kind",
        "name",
        "state",
        "source",
        "definition",
        "blocks",
        "requiredCapabilities",
        "externalDependencies",
        "targetHosts",
        "verificationRecords",
        "requiresExtension"
      ],
      "properties": {
        "schemaVersion": {
          "const": "1.0.0"
        },
        "id": {
          "type": "string",
          "pattern": "^E[PR]-(00[1-9]|0[1-9][0-9]|1[01][0-9]|120)$"
        },
        "kind": {
          "enum": [
            "project",
            "resource"
          ]
        },
        "resourceKind": {
          "enum": [
            "mcp",
            "instruction",
            "document",
            "skill"
          ]
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "state": {
          "enum": [
            "planned",
            "implemented",
            "verified",
            "published",
            "suspended"
          ]
        },
        "source": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "path",
            "row"
          ],
          "properties": {
            "path": {
              "const": "docs/specifications/official-catalog-design.md"
            },
            "row": {
              "type": "string",
              "minLength": 1
            },
            "referenceUrl": {
              "type": "string",
              "format": "uri"
            }
          }
        },
        "definition": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "purpose",
            "blocksAndConnections",
            "inputOutput",
            "acceptanceCriteria"
          ],
          "properties": {
            "purpose": {
              "type": "string",
              "minLength": 1
            },
            "blocksAndConnections": {
              "type": "string",
              "minLength": 1
            },
            "inputOutput": {
              "type": "string",
              "minLength": 1
            },
            "acceptanceCriteria": {
              "type": "string",
              "minLength": 1
            }
          }
        },
        "blocks": {
          "type": "array",
          "minItems": 1,
          "uniqueItems": true,
          "items": {
            "type": "string",
            "pattern": "^[a-z_]+$"
          }
        },
        "requiredCapabilities": {
          "type": "array",
          "minItems": 1,
          "uniqueItems": true,
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "externalDependencies": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "id",
              "kind",
              "requirement"
            ],
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9-]{0,63}$"
              },
              "kind": {
                "enum": [
                  "model",
                  "service",
                  "embedding",
                  "reranker",
                  "graph",
                  "browser",
                  "database",
                  "search"
                ]
              },
              "requirement": {
                "type": "string",
                "minLength": 1
              }
            }
          }
        },
        "targetHosts": {
          "type": "array",
          "minItems": 1,
          "uniqueItems": true,
          "items": {
            "enum": [
              "codex",
              "claude-code",
              "opencode"
            ]
          }
        },
        "requiresExtension": {
          "type": "boolean"
        },
        "artifact": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "rootPath",
            "entrypoint",
            "sha256",
            "files"
          ],
          "properties": {
            "rootPath": {
              "type": "string",
              "minLength": 1
            },
            "entrypoint": {
              "type": "string",
              "minLength": 1
            },
            "sha256": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "files": {
              "type": "array",
              "minItems": 3,
              "maxItems": 1000,
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "path",
                  "sha256",
                  "role"
                ],
                "properties": {
                  "path": {
                    "type": "string",
                    "minLength": 1
                  },
                  "sha256": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  },
                  "role": {
                    "enum": [
                      "entrypoint",
                      "readme",
                      "license",
                      "payload",
                      "sample-input"
                    ]
                  }
                }
              }
            }
          }
        },
        "verificationRecords": {
          "type": "array",
          "uniqueItems": true,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "path",
              "sha256"
            ],
            "properties": {
              "path": {
                "type": "string",
                "minLength": 1
              },
              "sha256": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              }
            }
          }
        },
        "review": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "reviewerId",
            "reviewedAt",
            "artifactSha256",
            "distinctPurposeConfirmed"
          ],
          "properties": {
            "reviewerId": {
              "type": "string",
              "minLength": 1
            },
            "reviewedAt": {
              "type": "string",
              "format": "date-time"
            },
            "artifactSha256": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "distinctPurposeConfirmed": {
              "const": true
            }
          }
        }
      }
    },
    "policy": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "approvalMode": {
          "const": "per_effect"
        },
        "networkMode": {
          "const": "broker_only"
        },
        "filesystemMode": {
          "const": "workspace_only"
        },
        "limits": {
          "type": "object",
          "properties": {
            "maxConcurrentNodes": {
              "type": "integer",
              "minimum": 1,
              "maximum": 32
            },
            "maxNodeInstances": {
              "type": "integer",
              "minimum": 1,
              "maximum": 100000
            },
            "maxModelCalls": {
              "type": "integer",
              "minimum": 1,
              "maximum": 100000
            },
            "maxTotalTokens": {
              "type": "integer",
              "minimum": 1,
              "maximum": 100000000
            },
            "maxActiveMs": {
              "type": "integer",
              "minimum": 1,
              "maximum": 86400000
            },
            "maxChildDepth": {
              "type": "integer",
              "minimum": 1,
              "maximum": 8
            }
          },
          "required": [
            "maxConcurrentNodes",
            "maxNodeInstances",
            "maxModelCalls",
            "maxTotalTokens",
            "maxActiveMs",
            "maxChildDepth"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "approvalMode",
        "networkMode",
        "filesystemMode",
        "limits"
      ],
      "additionalProperties": false,
      "title": "WorkflowPolicy"
    },
    "resource_descriptor": {
      "title": "ResourceDescriptor",
      "$comment": "A ResourceRef hashes the original resource.json bytes; this descriptor pins every payload and dependency.",
      "type": "object",
      "additionalProperties": false,
      "required": [
        "schemaVersion",
        "id",
        "revision",
        "kind",
        "name",
        "entrypoint",
        "license",
        "dependencies",
        "requiredConnections",
        "files"
      ],
      "properties": {
        "schemaVersion": {
          "const": "1.0.0"
        },
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "revision": {
          "type": "integer",
          "minimum": 1
        },
        "kind": {
          "enum": [
            "instruction",
            "document",
            "skill",
            "mcp"
          ]
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "entrypoint": {
          "type": "string",
          "minLength": 1
        },
        "license": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "id",
            "path"
          ],
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1
            },
            "path": {
              "type": "string",
              "minLength": 1
            }
          }
        },
        "dependencies": {
          "type": "object",
          "propertyNames": {
            "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
          },
          "additionalProperties": {
            "$ref": "#/$defs/resource_ref"
          }
        },
        "requiredConnections": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
          },
          "uniqueItems": true
        },
        "files": {
          "type": "array",
          "minItems": 1,
          "maxItems": 1000,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "path",
              "bytes",
              "sha256"
            ],
            "properties": {
              "path": {
                "type": "string",
                "minLength": 1
              },
              "bytes": {
                "type": "integer",
                "minimum": 0
              },
              "sha256": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              }
            }
          }
        }
      }
    },
    "resource_ref": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "kind": {
          "type": "string",
          "enum": [
            "mcp",
            "instruction",
            "document",
            "skill"
          ]
        },
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "revision": {
          "type": "integer",
          "minimum": 1
        },
        "sha256": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        }
      },
      "required": [
        "kind",
        "id",
        "revision",
        "sha256"
      ],
      "additionalProperties": false,
      "title": "ResourceRef"
    },
    "runtime_lock": {
      "title": "RuntimeRequirementsLock",
      "description": "Portable private-package requirements. Installed component, model and host identities are resolved locally into the immutable run plan; this is not a verified binary lock.",
      "type": "object",
      "properties": {
        "schemaVersion": {
          "const": "1.0.0"
        },
        "kind": {
          "const": "requirements"
        },
        "workflowSha256": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "runner": {
          "type": "object",
          "properties": {
            "version": {
              "const": "0.1.0"
            },
            "node": {
              "const": "24.22.1"
            }
          },
          "required": [
            "version",
            "node"
          ],
          "additionalProperties": false
        },
        "requiredCapabilities": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "uniqueItems": true
        },
        "host": {
          "type": "object",
          "properties": {
            "name": {
              "enum": [
                "codex",
                "claude-code",
                "opencode"
              ]
            },
            "verification": {
              "const": "unverified"
            },
            "testedVersions": {
              "type": "array",
              "maxItems": 0,
              "items": {
                "type": "string"
              }
            }
          },
          "required": [
            "name",
            "verification",
            "testedVersions"
          ],
          "additionalProperties": false
        },
        "modelProfiles": {
          "type": "object",
          "additionalProperties": true
        },
        "modelVerification": {
          "const": "unverified"
        }
      },
      "required": [
        "schemaVersion",
        "kind",
        "workflowSha256",
        "runner",
        "requiredCapabilities",
        "host",
        "modelProfiles",
        "modelVerification"
      ],
      "additionalProperties": false
    },
    "tool_ref": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "title": "ToolRef",
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "builtin"
            },
            "id": {
              "type": "string"
            },
            "version": {
              "type": "integer",
              "minimum": 1
            }
          },
          "required": [
            "kind",
            "id",
            "version"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "mcp"
            },
            "connection": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            },
            "name": {
              "type": "string"
            },
            "schemaSha256": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            }
          },
          "required": [
            "kind",
            "connection",
            "name",
            "schemaSha256"
          ],
          "additionalProperties": false
        }
      ]
    },
    "user_schema": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "title": "UserSchema",
      "anyOf": [
        {
          "type": "boolean"
        },
        {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/json_value"
          }
        }
      ],
      "description": "Untrusted user JSON Schema is additionally checked for supported keywords, safe references and complexity."
    },
    "verification_record": {
      "title": "VerificationRecord",
      "$comment": "Only an independently trusted verifier may attest an actual run. A JSON success flag or unit-test provider is insufficient.",
      "type": "object",
      "additionalProperties": false,
      "required": [
        "schemaVersion",
        "id",
        "exampleId",
        "artifactSha256",
        "definitionSha256",
        "mode",
        "mocked",
        "status",
        "host",
        "hostVersion",
        "runnerVersion",
        "startedAt",
        "finishedAt",
        "capabilities",
        "acceptanceCriteria",
        "steps",
        "dependencies",
        "evidence",
        "signature"
      ],
      "properties": {
        "schemaVersion": {
          "const": "1.0.0"
        },
        "id": {
          "type": "string",
          "minLength": 1
        },
        "exampleId": {
          "type": "string",
          "pattern": "^E[PR]-[0-9]{3}$"
        },
        "artifactSha256": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "definitionSha256": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "mode": {
          "const": "real"
        },
        "mocked": {
          "const": false
        },
        "status": {
          "const": "passed"
        },
        "host": {
          "enum": [
            "codex",
            "claude-code",
            "opencode"
          ]
        },
        "hostVersion": {
          "type": "string",
          "minLength": 1
        },
        "runnerVersion": {
          "type": "string",
          "minLength": 1
        },
        "startedAt": {
          "type": "string",
          "format": "date-time"
        },
        "finishedAt": {
          "type": "string",
          "format": "date-time"
        },
        "capabilities": {
          "type": "array",
          "uniqueItems": true,
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "acceptanceCriteria": {
          "type": "string",
          "minLength": 1
        },
        "steps": {
          "type": "array",
          "minItems": 2,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "kind",
              "passed",
              "evidencePath"
            ],
            "properties": {
              "kind": {
                "enum": [
                  "host-entry",
                  "runner-start",
                  "result-received",
                  "resource-use",
                  "acceptance-check"
                ]
              },
              "passed": {
                "const": true
              },
              "evidencePath": {
                "type": "string",
                "minLength": 1
              }
            }
          }
        },
        "dependencies": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "id",
              "mode",
              "version",
              "evidencePath"
            ],
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1
              },
              "mode": {
                "const": "actual"
              },
              "version": {
                "type": "string",
                "minLength": 1
              },
              "evidencePath": {
                "type": "string",
                "minLength": 1
              }
            }
          }
        },
        "evidence": {
          "type": "array",
          "minItems": 1,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "path",
              "sha256"
            ],
            "properties": {
              "path": {
                "type": "string",
                "minLength": 1
              },
              "sha256": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              }
            }
          }
        },
        "signature": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "algorithm",
            "keyId",
            "value"
          ],
          "properties": {
            "algorithm": {
              "const": "Ed25519"
            },
            "keyId": {
              "type": "string",
              "minLength": 1
            },
            "value": {
              "type": "string",
              "pattern": "^[A-Za-z0-9+/]+={0,2}$"
            }
          }
        }
      }
    },
    "workflow": {
      "$comment": "Canonical Studio v1 contract; generated TypeScript must not be edited independently.",
      "type": "object",
      "properties": {
        "schemaVersion": {
          "const": "1.0.0"
        },
        "id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "revision": {
          "type": "integer",
          "minimum": 1
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "description": {
          "type": "string",
          "maxLength": 4000
        },
        "entryNodeId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "inputs": {
          "$ref": "#/$defs/user_schema"
        },
        "outputs": {
          "$ref": "#/$defs/user_schema"
        },
        "nodes": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/node"
          },
          "minItems": 2
        },
        "edges": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/edge"
          },
          "minItems": 0
        },
        "modelProfiles": {
          "type": "object",
          "additionalProperties": {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "enum": [
                  "chat",
                  "embedding",
                  "reranker"
                ]
              },
              "requiredFeatures": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "minItems": 0
              }
            },
            "required": [
              "kind",
              "requiredFeatures"
            ],
            "additionalProperties": false
          }
        },
        "resources": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/resource_ref"
          }
        },
        "subworkflows": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/flow"
          }
        },
        "policy": {
          "$ref": "#/$defs/policy"
        }
      },
      "required": [
        "schemaVersion",
        "id",
        "revision",
        "name",
        "entryNodeId",
        "inputs",
        "outputs",
        "nodes",
        "edges",
        "modelProfiles",
        "resources",
        "subworkflows",
        "policy"
      ],
      "additionalProperties": false,
      "title": "Workflow"
    }
  }
};

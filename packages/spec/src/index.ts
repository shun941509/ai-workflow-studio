/** Public contracts are generated from JSON Schema; runtime validators and editor defaults share them. */
export type { FileRef } from './generated/file-ref.generated.js';
export type { TextResourceLicense } from './generated/text-resource-license.generated.js';
export type { CompletionContract, CompletionCriterion } from './generated/completion.generated.js';
export type { RunOutcome, CompletionCheck } from './generated/run-outcome.generated.js';
export { validateCompletionDeclaration, validateRunOutcome } from './completion-validation.js';
export { validateWorkDefinitionDeclaration } from './work-definition-validation.js';
export type { WorkDefinition } from './work-definition-validation.js';
export { NODE_SUPPORT_INVENTORY, EDITOR_NODE_TYPES, DOCUMENTED_RUNNER_CAPABILITIES, SUPPORT_INVENTORY_VERIFICATION } from './support-inventory.js';
export type { EditorNodeType, NodeSupport, SupportMode } from './support-inventory.js';
export { checkedTextResourceLicense } from './text-resource-license.js';
export type { Workflow, WorkflowNode, Binding, FlowDefinition, ResourceRef, FlowRef, ToolRef, WorkflowEdge, ExecutionPolicy, WorkflowPolicy, JsonValue, UserSchema } from './generated/types.generated.js';
export type { NodeType, NodeDefinition } from './registry.js';
export type { ValidationIssue, ValidationResult } from './validation.js';
export { BASIC_CAPABILITIES, NODE_DEFINITIONS, createBasicWorkflow, createNode, getNodeDefinition } from './registry.js';
export { createSchemaValidator, validateWorkflowShape, validateNodeShape, validateNodeConfig, validateJsonValue, parseWorkflowJson } from './validation.js';
export { parseStrictJson, StrictJsonError, assertJsonData, FORBIDDEN_KEYS } from './strict-json.js';

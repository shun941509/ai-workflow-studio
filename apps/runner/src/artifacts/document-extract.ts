import { createHash } from 'node:crypto';
import type { WorkflowNode } from '@studio/spec';
import { validateTextExtraction, type NodeOutput } from '@studio/workflow-core';
import type { ArtifactStore } from './store.js';
import { decodeUtf8Document } from './text-document.js';

/** This builtin reads one verified managed artifact; it never opens a supplied path or executes a document. */
export function executeTextExtraction(node: Extract<WorkflowNode, { type: 'document_extract' }>, inputs: Record<string, unknown>, context: { store: ArtifactStore; runId: string }): NodeOutput {
  validateTextExtraction(node);
  const reference = context.store.resolve(context.runId, inputs.file);
  const { bytes } = context.store.read(context.runId, reference.id);
  const text = decodeUtf8Document(reference, bytes);
  const source = {
    file: reference,
    extractor: { id: 'builtin-utf8-verbatim', version: 1 },
    textSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    location: { encoding: 'utf8', start: 0, end: bytes.byteLength },
  };
  // Empty table/uncertainty lists mean no OCR/table conversion occurred, not that the document's claims are verified.
  return { data: { text, tables: [], locations: [source], uncertainties: [], extraction: 'verbatim_utf8' }, text, sources: [source] };
}

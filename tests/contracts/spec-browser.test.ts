// The browser contract must keep the Runner's no-eval CSP while using the canonical generated schema.
import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { createContext, Script } from 'node:vm';
import { resolve } from 'node:path';

it('validates outcomes in a browser bundle with dynamic code generation disabled', async () => {
  const bundle = await build({ entryPoints: [resolve('packages/spec/src/browser.ts')], bundle: true, platform: 'browser', format: 'iife', globalName: 'StudioBrowserSpec', write: false, metafile: true });
  // A type-only server import must not silently pull Ajv's compiler into this strict-CSP entry point.
  expect(Object.keys(bundle.metafile!.inputs).some(path => /ajv\/dist\/(compile|core|2020)/.test(path))).toBe(false);
  const context = createContext({}, { codeGeneration: { strings: false, wasm: false } });
  new Script(bundle.outputFiles[0]!.text).runInContext(context);
  const legacy = { version: 1, status: 'unassessed', reason: 'criteria_missing', planHash: null, criteriaHash: null, resultHash: null, assessedAt: null, checks: [] };
  const validate = (value: unknown): boolean => new Script(`StudioBrowserSpec.validateRunOutcome(${JSON.stringify(value)}).valid`).runInContext(context);
  expect(validate(legacy)).toBe(true);
  expect(validate({ ...legacy, status: 'complete', reason: 'criteria_satisfied' })).toBe(false);
  expect(validate({ ...legacy, version: '1' })).toBe(false);
  expect(validate({ ...legacy, authorization: 'not-allowed' })).toBe(false);
  expect(validate({ ...legacy, assessedAt: 'invalid-date' })).toBe(false);
});

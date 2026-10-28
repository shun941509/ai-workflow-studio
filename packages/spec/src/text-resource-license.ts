import schema from '../schemas/text-resource-license.schema.json' with { type: 'json' };
import type { TextResourceLicense } from './generated/text-resource-license.generated.js';
import { createSchemaValidator } from './validation.js';
import { assertJsonData } from './strict-json.js';

const validate = createSchemaValidator().compile<TextResourceLicense>(schema);
/** A user's declaration is immutable content, not an operator's verified permission or an automatic publish action. */
export function checkedTextResourceLicense(value: unknown): TextResourceLicense {
  assertJsonData(value);
  if (!validate(value) || !value.copyrightHolder.trim() || value.copyrightHolder !== value.copyrightHolder.trim()) throw new Error('TEXT_LICENSE_INVALID');
  return structuredClone(value);
}

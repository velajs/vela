import { parseSchemaAsync, SchemaValidationError } from '@velajs/vela';
import { InputValidationException } from '../envelope/errors';
import type { EngineRequest } from './engine-request';
import type { CrudResource } from './resource';

/** The same identifier contract applies to point routes and every batch item. */
export async function parseIdentifier(
  resource: CrudResource,
  value: unknown,
): Promise<EngineRequest['id']> {
  const schema = resource.config.contracts?.id ?? resource.model.contracts?.id;
  let input = value;
  if (resource.model.primaryKeys.length > 1 && typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      throw new InputValidationException('Invalid compound identifier');
    }
  }
  try {
    const parsed = schema ? await parseSchemaAsync(schema, input) : input;
    if (typeof parsed === 'string' || (typeof parsed === 'number' && Number.isFinite(parsed)))
      return String(parsed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const id: Record<string, string | number> = {};
      for (const [key, part] of Object.entries(parsed)) {
        if (typeof part !== 'string' && !(typeof part === 'number' && Number.isFinite(part)))
          throw new InputValidationException('Invalid identifier output');
        id[key] = part;
      }
      return id;
    }
    throw new InputValidationException('Invalid identifier output');
  } catch (error) {
    if (error instanceof SchemaValidationError)
      throw new InputValidationException(
        'Invalid identifier',
        error.issues.map((issue) => ({
          path: (issue.path ?? [])
            .map((part) => (typeof part === 'object' ? String(part.key) : String(part)))
            .join('.'),
          message: issue.message,
          code: 'validation',
        })),
      );
    throw error;
  }
}

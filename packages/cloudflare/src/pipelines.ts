import {
  isStandardSchema,
  parseSchemaAsync,
  SchemaValidationError,
  type StandardSchemaV1,
} from '@velajs/vela/validation';

/** The native stream handle remains usable independently of the writer. */
export interface PipelinesBinding<Output = Record<string, unknown>> {
  readonly send: (records: Output[]) => Promise<void>;
}

export interface PipelinesWriter<Input> {
  /** Validate the entire nonempty batch, then await one native ingestion request. */
  send(records: readonly Input[]): Promise<void>;
}

// Current streams document 5 MB per ingestion request, without a separate record
// cap. Use decimal MB conservatively, including JSON array brackets and commas.
// https://developers.cloudflare.com/pipelines/platform/limits/
const MAX_BATCH_BYTES = 5_000_000;
const encoder = new TextEncoder();

/**
 * Bind a Standard Schema producer to one trusted, configured stream. Schema
 * outputs must fit the binding's record type; send() accepts schema inputs.
 * Resolution means ingestion acceptance only, not downstream delivery or query
 * visibility. There is no retry, splitting, buffering, or cross-writer state.
 */
export function createPipelinesWriter<S extends StandardSchemaV1<unknown, Record<string, unknown>>>(
  binding: PipelinesBinding<NoInfer<StandardSchemaV1.InferOutput<S>>>,
  { schema }: { readonly schema: S },
): PipelinesWriter<StandardSchemaV1.InferInput<S>> {
  if (!binding || typeof binding.send !== 'function') {
    throw new TypeError('Pipelines requires a stream binding with send(records).');
  }
  if (!isStandardSchema(schema)) {
    throw new TypeError('Pipelines requires a Standard Schema validator.');
  }

  return {
    async send(records) {
      if (!Array.isArray(records) || records.length === 0) {
        throw new TypeError('Pipelines requires a nonempty array of records.');
      }
      // Capture batch membership before the first asynchronous validation.
      const inputs: unknown[] = [];
      for (let index = 0; index < records.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(records, String(index));
        if (!descriptor || !('value' in descriptor)) {
          throw new TypeError(
            `Pipelines record ${index} must be an array element, not an accessor or hole.`,
          );
        }
        inputs.push(descriptor.value);
      }

      const outputs: StandardSchemaV1.InferOutput<S>[] = [];
      let batchBytes = 2;
      for (const [index, input] of inputs.entries()) {
        let output: unknown;
        try {
          output = await parseSchemaAsync(schema, input);
        } catch (error) {
          if (error instanceof SchemaValidationError) {
            throw new SchemaValidationError(
              error.issues.map((issue) => ({ ...issue, path: [index, ...(issue.path ?? [])] })),
            );
          }
          throw error;
        }
        if (output === null || typeof output !== 'object' || Array.isArray(output)) {
          throw new TypeError(`Pipelines record ${index} must validate to a JSON object.`);
        }
        // Snapshot now: later async validators or callers may mutate earlier
        // outputs. The native send must receive exactly the JSON we checked.
        const snapshot = snapshotJson(output, [index], new Set());
        const bytes = encoder.encode(JSON.stringify(snapshot)).byteLength;
        if (bytes > MAX_BATCH_BYTES - 2) {
          throw new RangeError(
            `Pipelines record ${index} exceeds ${MAX_BATCH_BYTES - 2} JSON bytes.`,
          );
        }
        batchBytes += bytes + (index === 0 ? 0 : 1);
        if (batchBytes > MAX_BATCH_BYTES) {
          throw new RangeError(`Pipelines batch exceeds ${MAX_BATCH_BYTES} JSON bytes.`);
        }
        // The schema checked the shape; snapshotJson only copies JSON data and
        // rejects values JSON would silently drop or coerce.
        outputs.push(snapshot as StandardSchemaV1.InferOutput<S>);
      }
      await binding.send(outputs);
    },
  };
}

function snapshotJson(value: unknown, path: (string | number)[], ancestors: Set<object>): unknown {
  const invalid = (reason: string): never => {
    throw new TypeError(`Pipelines JSON value at ${JSON.stringify(path)} ${reason}.`);
  };
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid('must be finite');
    return value;
  }
  if (typeof value !== 'object') return invalid('is not representable');
  if (ancestors.has(value)) return invalid('is circular');
  const array = Array.isArray(value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype)) {
    return invalid('must use a plain object or array');
  }
  ancestors.add(value);
  try {
    // Native RPC bindings require ordinary objects, including when the input
    // has a null prototype. Define own properties below to preserve __proto__.
    const copy: Record<string, unknown> | unknown[] = array ? [] : {};
    const keys = Reflect.ownKeys(value);
    if (array && keys.length !== value.length + 1) return invalid('must be a dense array');
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') return invalid('cannot have symbol keys');
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) {
        return invalid('cannot have extra array properties');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
        return invalid('must contain only enumerable data properties');
      }
      const child = snapshotJson(descriptor.value, [...path, array ? Number(key) : key], ancestors);
      Object.defineProperty(copy, key, {
        value: child,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}

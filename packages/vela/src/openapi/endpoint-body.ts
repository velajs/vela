import type { JsonSchema } from './types';

/** Form limits count every part, including repeated and unknown fields. */
export interface EndpointFormLimits {
  /** Total encoded body bytes, including multipart overhead. Defaults to 1 MiB. */
  maxBytes?: number;
  /** Number of text entries. Defaults to 100. */
  maxFields?: number;
  /** UTF-8 bytes per text entry (including its name). Defaults to 64 KiB. */
  maxFieldBytes?: number;
  /** Number of file entries. Defaults to 10. */
  maxFiles?: number;
  /** Bytes per file. Defaults to 1 MiB. */
  maxFileBytes?: number;
}

export type EndpointBodyOptions =
  | { contentType: 'application/json'; maxBytes?: number }
  | ({
      contentType: 'multipart/form-data' | 'application/x-www-form-urlencoded';
    } & EndpointFormLimits);

export interface EndpointFormField {
  readonly name: string;
  readonly multiple: boolean;
  readonly file: boolean;
}

/** Resolved wire contract. Limits supplement the application's body security policy. */
export type EndpointBodyContract =
  | { readonly contentType: 'application/json'; readonly maxBytes?: number }
  | (Readonly<Required<EndpointFormLimits>> & {
      readonly contentType: 'multipart/form-data' | 'application/x-www-form-urlencoded';
      readonly fields: readonly EndpointFormField[];
    });

export function resolveEndpointBody(
  input: JsonSchema,
  options?: EndpointBodyOptions,
): EndpointBodyContract | undefined {
  if (
    options &&
    !['application/json', 'multipart/form-data', 'application/x-www-form-urlencoded'].includes(
      options.contentType,
    )
  )
    throw new Error('Unsupported endpoint body contentType.');
  const json = input.properties?.json;
  const form = input.properties?.form;
  if (json && form) throw new Error('Endpoint input cannot combine json and form bodies.');
  if (!json && !form) {
    if (options) throw new Error('Endpoint body options require a json or form input group.');
    return undefined;
  }
  if (json) {
    if (options && options.contentType !== 'application/json')
      throw new Error('Endpoint json group requires application/json.');
    if (options?.maxBytes !== undefined) positiveLimit('maxBytes', options.maxBytes);
    return Object.freeze({ contentType: 'application/json', maxBytes: options?.maxBytes });
  }
  if (!options || options.contentType === 'application/json')
    throw new Error('Endpoint form group requires an explicit form body contentType.');
  if (
    !form ||
    form.type !== 'object' ||
    !form.properties ||
    form.$ref ||
    form.anyOf ||
    form.oneOf ||
    form.allOf ||
    form.nullable ||
    (form.additionalProperties !== undefined && form.additionalProperties !== false)
  )
    throw new Error(
      'Endpoint form must export an object with named fields and no additionalProperties schema.',
    );
  const limits = {
    maxBytes: options.maxBytes ?? 1024 * 1024,
    maxFields: options.maxFields ?? 100,
    maxFieldBytes: options.maxFieldBytes ?? 64 * 1024,
    maxFiles: options.maxFiles ?? 10,
    maxFileBytes: options.maxFileBytes ?? 1024 * 1024,
  };
  for (const [key, value] of Object.entries(limits)) positiveLimit(key, value);
  const fields = Object.entries(form.properties).map(([name, schema]) => {
    const multiple = schema.type === 'array';
    const value = multiple ? schema.items : schema;
    for (const candidate of [schema, value]) {
      if (
        !candidate ||
        candidate.$ref ||
        candidate.anyOf ||
        candidate.oneOf ||
        candidate.allOf ||
        candidate.nullable
      )
        throw new Error(
          `Endpoint form field ${name} needs a concrete string/file or array wire schema.`,
        );
    }
    if (value?.type !== 'string')
      throw new Error(
        `Endpoint form field ${name} must receive strings or binary files; transform wire strings in the input schema.`,
      );
    const file = value.format === 'binary';
    if (file && options.contentType !== 'multipart/form-data')
      throw new Error(`Endpoint form file ${name} requires multipart/form-data.`);
    if (value.contentEncoding !== undefined && !(file && value.contentEncoding === 'binary'))
      throw new Error(`Endpoint form field ${name} has an unsupported contentEncoding.`);
    if (file && (value.enum || 'const' in value))
      throw new Error(`Endpoint form file ${name} cannot declare scalar literals.`);
    return Object.freeze({ name, multiple, file });
  });
  return Object.freeze({
    ...limits,
    contentType: options.contentType,
    fields: Object.freeze(fields),
  });
}

function positiveLimit(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`Endpoint body ${name} must be a positive safe integer.`);
}

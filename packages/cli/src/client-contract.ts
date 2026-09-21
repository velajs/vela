import type { HttpVerb } from '@velajs/vela';
import { parseClientContractDocument } from './client-contract-input.js';
import type {
  ContractOperation,
  ContractParameter,
  ContractSchema,
} from './client-contract-input.js';

const METHODS: HttpVerb[] = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];
const quote = (value: string): string => JSON.stringify(value);
// Hono uses -1 for unofficial statuses. Reject those here so the generated
// status literals always satisfy its public StatusCode contract.
const HTTP_STATUSES = new Set([
  100, 101, 102, 103, 200, 201, 202, 203, 204, 205, 206, 207, 208, 226, 300, 301, 302, 303, 304,
  305, 306, 307, 308, 400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 414,
  415, 416, 417, 418, 421, 422, 423, 424, 425, 426, 428, 429, 431, 451, 500, 501, 502, 503, 504,
  505, 506, 507, 508, 510, 511,
]);

export interface GeneratedClientContract {
  source: string;
  warnings: string[];
}

/** Generate hc types and optional form encoding metadata, without application imports. */
export function generateClientContract(input: unknown): GeneratedClientContract {
  const document = parseClientContractDocument(input);
  const warnings = new Set<string>();
  const components = document.components?.schemas ?? {};
  const formEncodings: { path: string; method: string; contentType: string }[] = [];
  let usesHttpStatus = false;
  const warn = (message: string): void => {
    warnings.add(message);
  };

  function schemaType(schema: ContractSchema | undefined, at: string): string {
    if (schema === false) return 'never';
    if (schema === true) return 'unknown';
    if (!schema || Object.keys(schema).length === 0) {
      warn(`${at}: no schema; emitted unknown.`);
      return 'unknown';
    }
    if (schema.readOnly || schema.writeOnly) {
      throw new Error(
        `${at}: readOnly/writeOnly schemas require separate request and response definitions.`,
      );
    }
    for (const keyword of [
      '$dynamicRef',
      'prefixItems',
      'patternProperties',
      'not',
      'if',
      'then',
      'else',
      'dependentSchemas',
      'unevaluatedProperties',
    ] as const) {
      if (schema[keyword] !== undefined)
        throw new Error(`${at}: unsupported schema keyword ${keyword}.`);
    }
    const parts: string[] = [];
    if (schema.$ref) {
      const prefix = '#/components/schemas/';
      const name = schema.$ref.startsWith(prefix)
        ? schema.$ref.slice(prefix.length).replace(/~1/g, '/').replace(/~0/g, '~')
        : undefined;
      if (name === undefined || !Object.hasOwn(components, name)) {
        throw new Error(
          `${at}: unsupported or unresolved reference ${schema.$ref}. Bundle references into components.schemas first.`,
        );
      }
      parts.push(`Schemas[${quote(name)}]`);
    }
    if ('const' in schema) parts.push(literal(schema.const, at));
    else if (schema.enum) parts.push(schema.enum.map((v) => literal(v, at)).join(' | ') || 'never');
    for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
      const members = schema[key];
      if (members)
        parts.push(
          members.map((s) => `(${schemaType(s, at)})`).join(key === 'allOf' ? ' & ' : ' | ') ||
            'never',
        );
    }
    if (Array.isArray(schema.type)) {
      parts.push(
        schema.type
          .map((type) =>
            schemaType(
              {
                ...schema,
                type,
                nullable: false,
                $ref: undefined,
                enum: undefined,
                oneOf: undefined,
                anyOf: undefined,
                allOf: undefined,
              },
              at,
            ),
          )
          .join(' | '),
      );
    } else if (
      schema.type === 'object' ||
      (schema.type === undefined && (schema.properties || schema.additionalProperties))
    ) {
      const required = new Set(schema.required ?? []);
      const fields = Object.entries(schema.properties ?? {})
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(
          ([key, value]) =>
            `${quote(key)}${required.has(key) ? '' : '?'}: ${schemaType(value, `${at}.${key}`)};`,
        );
      if (schema.additionalProperties !== false) {
        // Unknown is intentional when properties coexist with a dictionary:
        // a narrow index signature could make declared properties impossible.
        const additional =
          typeof schema.additionalProperties === 'object' && fields.length === 0
            ? schemaType(schema.additionalProperties, `${at}.*`)
            : 'unknown';
        if (typeof schema.additionalProperties === 'object' && fields.length > 0)
          warn(`${at}: additionalProperties alongside named properties is widened to unknown.`);
        fields.push(`[key: string]: ${additional};`);
      }
      parts.push(fields.length ? `{ ${fields.join(' ')} }` : 'Record<string, never>');
    } else if (schema.type === 'array') {
      parts.push(`Array<${schemaType(schema.items, `${at}[]`)}>`);
    } else if (schema.type === 'string') {
      parts.push(schema.format === 'binary' ? 'File | Blob' : 'string');
    } else if (schema.type === 'number' || schema.type === 'integer') {
      parts.push('number');
    } else if (schema.type === 'boolean' || schema.type === 'null') {
      parts.push(schema.type);
    } else if (schema.type) {
      throw new Error(`${at}: unsupported schema type ${schema.type}.`);
    }
    if (!parts.length) {
      warn(`${at}: schema has no representable type; emitted unknown.`);
      return 'unknown';
    }
    const value = parts.map((part) => `(${part})`).join(' & ');
    return schema.nullable ? `(${value}) | null` : value;
  }

  function resolveFormSchema(
    value: ContractSchema | undefined,
    at: string,
    seen = new Set<string>(),
  ): Exclude<ContractSchema, boolean> {
    if (!value || typeof value !== 'object')
      throw new Error(`${at}: form fields require concrete schemas.`);
    if (!value.$ref) return value;
    const prefix = '#/components/schemas/';
    const name = value.$ref.startsWith(prefix)
      ? value.$ref.slice(prefix.length).replace(/~1/g, '/').replace(/~0/g, '~')
      : '';
    if (!Object.hasOwn(components, name))
      throw new Error(`${at}: unsupported or unresolved reference ${value.$ref}.`);
    if (seen.has(value.$ref)) throw new Error(`${at}: recursive form schemas are unsupported.`);
    if (Object.keys(value).some((key) => !['$ref', 'description', 'title'].includes(key)))
      throw new Error(`${at}: form references with schema siblings are unsupported.`);
    return resolveFormSchema(components[name], at, new Set(seen).add(value.$ref));
  }

  function formType(
    value: ContractSchema | undefined,
    encoding: unknown,
    contentType: string,
    at: string,
  ): string {
    const schema = resolveFormSchema(value, at);
    schemaType(schema, at); // Retain the generator's structural-keyword checks.
    if (
      schema.type !== 'object' ||
      !schema.properties ||
      schema.oneOf ||
      schema.anyOf ||
      schema.allOf ||
      schema.nullable ||
      (schema.additionalProperties !== undefined && schema.additionalProperties !== false)
    )
      throw new Error(
        `${at}: form bodies require an object with named fields and no additionalProperties schema.`,
      );
    if (encoding !== undefined) {
      if (encoding === null || typeof encoding !== 'object' || Array.isArray(encoding))
        throw new Error(`${at}: invalid form encoding.`);
      for (const [name, entry] of Object.entries(encoding)) {
        if (
          !Object.hasOwn(schema.properties, name) ||
          !entry ||
          typeof entry !== 'object' ||
          Array.isArray(entry) ||
          Object.entries(entry).some(
            ([key, value]) =>
              !((key === 'style' && value === 'form') || (key === 'explode' && value === true)),
          )
        )
          throw new Error(
            `${at}: unsupported form serialization for ${name}; use repeated fields with style form and explode true.`,
          );
      }
    }
    const fieldType = (value: ContractSchema | undefined, name: string, array = false): string => {
      const field = resolveFormSchema(value, `${at}.${name}`);
      schemaType(field, `${at}.${name}`);
      if (
        field.oneOf ||
        field.anyOf ||
        field.allOf ||
        field.nullable ||
        field.readOnly ||
        field.writeOnly
      )
        throw new Error(`${at}.${name}: ambiguous form wire schema.`);
      if (field.type === 'array' && !array) return `Array<${fieldType(field.items, name, true)}>`;
      if (field.type !== 'string')
        throw new Error(
          `${at}.${name}: form wire fields must be strings, binary files, or arrays of these.`,
        );
      const file = field.format === 'binary';
      if (file && contentType !== 'multipart/form-data')
        throw new Error(`${at}.${name}: files require multipart/form-data.`);
      if (field.contentEncoding !== undefined && !(file && field.contentEncoding === 'binary'))
        throw new Error(`${at}.${name}: unsupported contentEncoding.`);
      if (
        (field.enum && field.enum.some((entry) => typeof entry !== 'string')) ||
        ('const' in field && typeof field.const !== 'string') ||
        (file && (field.enum || 'const' in field))
      )
        throw new Error(`${at}.${name}: invalid form scalar literal.`);
      return schemaType(field, `${at}.${name}`);
    };
    const required = new Set(schema.required ?? []);
    const fields = Object.entries(schema.properties)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(
        ([name, value]) =>
          `${quote(name)}${required.has(name) ? '' : '?'}: ${fieldType(value, name)};`,
      );
    return fields.length ? `{ ${fields.join(' ')} }` : 'Record<string, never>';
  }

  function rejectBinaryJson(
    value: ContractSchema | undefined,
    at: string,
    seen = new Set<string>(),
  ): void {
    if (!value || typeof value !== 'object') return;
    if (value.format === 'binary')
      throw new Error(
        `${at}: binary files require multipart form fields; JSON/text serialization is unsupported.`,
      );
    if (value.$ref && !seen.has(value.$ref)) {
      seen.add(value.$ref);
      const name = value.$ref
        .slice('#/components/schemas/'.length)
        .replace(/~1/g, '/')
        .replace(/~0/g, '~');
      rejectBinaryJson(components[name], at, seen);
    }
    for (const child of [
      ...Object.values(value.properties ?? {}),
      value.items,
      typeof value.additionalProperties === 'object' ? value.additionalProperties : undefined,
      ...(value.oneOf ?? []),
      ...(value.anyOf ?? []),
      ...(value.allOf ?? []),
    ])
      rejectBinaryJson(child, at, seen);
  }

  function wireType(
    value: ContractSchema | undefined,
    at: string,
    seen = new Set<string>(),
  ): string {
    if (value === false) return 'never';
    const schema = value === true ? undefined : value;
    if (schema?.$ref) {
      schemaType(schema, at); // validate reference
      if (seen.has(schema.$ref))
        throw new Error(`${at}: recursive parameter schemas are unsupported.`);
      const name = schema.$ref
        .slice('#/components/schemas/'.length)
        .replace(/~1/g, '/')
        .replace(/~0/g, '~');
      return wireType(components[name], at, new Set(seen).add(schema.$ref));
    }
    if (schema?.type === 'array') {
      const item = wireType(schema.items, at, seen);
      if (item.startsWith('Array<')) throw new Error(`${at}: nested query arrays are unsupported.`);
      return `Array<${item}>`;
    }
    if (
      schema?.type === 'object' ||
      schema?.properties ||
      schema?.oneOf ||
      schema?.anyOf ||
      schema?.allOf ||
      Array.isArray(schema?.type)
    ) {
      throw new Error(
        `${at}: structured parameters need a custom serializer and are not supported by this generator.`,
      );
    }
    if (schema?.enum) return schema.enum.map((v) => quote(String(v))).join(' | ') || 'never';
    return 'string';
  }

  function inputType(
    path: string,
    operation: ContractOperation,
    at: string,
    method: string,
  ): string {
    const parameters = [...(operation.parameters ?? [])];
    for (const p of parameters) {
      if (!['path', 'query', 'header', 'cookie'].includes(p.in) || typeof p.name !== 'string')
        throw new Error(`${at}: unresolved or invalid parameter.`);
    }
    for (const match of path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const name = match[1]!;
      if (!parameters.some((p) => p.in === 'path' && p.name === name))
        parameters.push({ name, in: 'path', required: true });
    }
    const fields: string[] = [];
    for (const [location, key] of [
      ['path', 'param'],
      ['query', 'query'],
      ['header', 'header'],
    ] as const) {
      const group = parameters.filter((p) => p.in === location);
      if (!group.length) continue;
      const required = location === 'path' || group.some((p) => p.required);
      fields.push(
        `${key}${required ? '' : '?'}: { ${group.map((p) => parameterType(p, location, at)).join(' ')} };`,
      );
    }
    if (parameters.some((p) => p.in === 'cookie'))
      throw new Error(
        `${at}: cookie parameters are unsupported; configure browser credentials through hc options.`,
      );
    if (operation.requestBody) {
      const body = operation.requestBody;
      if (body.$ref)
        throw new Error(`${at}: resolve requestBody references before generating a client.`);
      const content = body.content ?? {};
      const media = Object.keys(content);
      const contentType = media[0];
      if (
        media.length !== 1 ||
        !contentType ||
        !['application/json', 'multipart/form-data', 'application/x-www-form-urlencoded'].includes(
          contentType,
        )
      )
        throw new Error(
          `${at}: request bodies must declare exactly one supported media type: application/json, multipart/form-data, or application/x-www-form-urlencoded.`,
        );
      if (method === 'get' || method === 'head')
        throw new Error(`${at}: hc cannot send a request body for GET or HEAD.`);
      const entry = content[contentType];
      if (contentType === 'application/json') {
        rejectBinaryJson(entry?.schema, `${at} request body`);
        fields.push(
          `json${body.required ? '' : '?'}: ${schemaType(entry?.schema, `${at} request body`)};`,
        );
      } else {
        fields.push(
          `form${body.required ? '' : '?'}: ${formType(entry?.schema, entry?.encoding, contentType, `${at} request body`)};`,
        );
        formEncodings.push({ path, method: method.toUpperCase(), contentType });
      }
    }
    return fields.length ? `{ ${fields.join(' ')} }` : '{}';
  }

  function parameterType(p: ContractParameter, location: string, at: string): string {
    if (p.$ref || p.style || p.explode === false || p.content !== undefined)
      throw new Error(
        `${at}: custom parameter serialization/references are unsupported (${p.name}).`,
      );
    const type = wireType(p.schema, `${at} parameter ${p.name}`);
    if (location !== 'query' && type.startsWith('Array<'))
      throw new Error(`${at}: only query parameters support arrays.`);
    return `${quote(p.name)}${location === 'path' || p.required ? '' : '?'}: ${type};`;
  }

  const paths: string[] = [];
  for (const [openApiPath, item] of Object.entries(document.paths).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    // Hono's proxy consumes one path segment per property. Reject templates it
    // cannot faithfully round-trip rather than generate a misleading client.
    if (
      !openApiPath.startsWith('/') ||
      openApiPath
        .slice(1)
        .split('/')
        .some(
          (segment) =>
            segment !== '' && !/^(?:[A-Za-z0-9_.~-]+|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(segment),
        ) ||
      openApiPath.includes('//') ||
      (openApiPath !== '/' && openApiPath.endsWith('/'))
    )
      throw new Error(`Unsupported client path: ${openApiPath}`);
    const path = openApiPath.replace(/\{([^}]+)\}/g, ':$1');
    if (
      path
        .split('/')
        .some(
          (segment) => ['index', 'then', '.', '..'].includes(segment) || segment.startsWith('$'),
        )
    )
      throw new Error(`Reserved hc path segment: ${path}`);
    if ('parameters' in item || '$ref' in item)
      throw new Error(`${path}: resolve path-level parameters/references into operations first.`);
    const methods: string[] = [];
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation) continue;
      const at = `${method.toUpperCase()} ${path}`;
      const unsupported = operation['x-vela-client-unsupported'];
      if (unsupported?.length) throw new Error(`${at}: ${unsupported.join(' ')}`);
      const input = inputType(path, operation, at, method);
      const explicitStatuses = Object.keys(operation.responses).filter((s) => /^\d{3}$/.test(s));
      const variants: string[] = [];
      for (const [status, response] of Object.entries(operation.responses).toSorted(([a], [b]) =>
        a.localeCompare(b),
      )) {
        if (response.$ref)
          throw new Error(`${at}: resolve response references before generating a client.`);
        let statusType: string;
        if (/^[1-5]\d\d$/.test(status) && HTTP_STATUSES.has(Number(status))) statusType = status;
        else if (status === 'default')
          statusType = `Exclude<HttpStatus, ${
            Object.keys(operation.responses)
              .filter((s) => s !== 'default')
              .map((s) => (/^[1-5]XX$/.test(s) ? rangeStatus(s) : s))
              .join(' | ') || 'never'
          }>`;
        else if (/^[1-5]XX$/.test(status))
          statusType = `Exclude<${rangeStatus(status)}, ${explicitStatuses.join(' | ') || 'never'}>`;
        else throw new Error(`${at}: unsupported response status ${status}.`);
        if (statusType.includes('HttpStatus')) usesHttpStatus = true;
        const content = response.content ?? {};
        const media = Object.keys(content);
        if (
          media.length > 1 ||
          (media.length === 1 && media[0] !== 'application/json' && media[0] !== 'text/plain')
        )
          throw new Error(`${at}: responses must declare one JSON or text media type.`);
        const format = media[0] === 'text/plain' ? 'text' : 'json';
        rejectBinaryJson(content[media[0] ?? '']?.schema, `${at} response ${status}`);
        const bodyType =
          ['101', '204', '205', '304'].includes(status) || method === 'head'
            ? 'never'
            : schemaType(content[media[0] ?? '']?.schema, `${at} response ${status}`);
        // text() always returns a string, even if the document describes a
        // numeric or unconstrained text payload. Preserve string literals.
        const output =
          format === 'text'
            ? `Extract<${bodyType}, string> extends never ? string : Extract<${bodyType}, string>`
            : bodyType;
        variants.push(
          `{ input: ${input}; output: ${output}; outputFormat: '${format}'; status: ${statusType} }`,
        );
      }
      if (!variants.length) throw new Error(`${at}: at least one response is required.`);
      methods.push(`    $${method}: ${variants.join(' | ')};`);
    }
    if (methods.length) paths.push(`  ${quote(path)}: {\n${methods.join('\n')}\n  };`);
  }

  const schemas = Object.entries(components)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([name, schema]) => `  ${quote(name)}: ${schemaType(schema, `schema ${name}`)};`);
  const source = [
    '// Generated by vela client generate. Do not edit.',
    `import type { HttpApp${usesHttpStatus ? ', HttpStatus' : ''}${formEncodings.length ? ', HttpFormEncoding' : ''} } from '@velajs/client/http';`,
    '',
    `export type Schemas = {\n${schemas.join('\n')}\n};`,
    '',
    `export type AppType = HttpApp<{\n${paths.join('\n')}\n}>;`,
    ...(formEncodings.length
      ? [
          '',
          '// hc sends multipart by default. Use fetch: withFormEncoding(formEncodings, yourFetch)',
          '// from @velajs/client/http to honor URL-encoded routes. Wrap per-call fetch overrides too.',
          `export const formEncodings = ${JSON.stringify(formEncodings, null, 2)} as const satisfies readonly HttpFormEncoding[];`,
        ]
      : []),
    '',
  ].join('\n');
  return { source, warnings: [...warnings] };
}

function literal(value: unknown, at: string): string {
  if (value === null || ['string', 'boolean', 'number'].includes(typeof value))
    return JSON.stringify(value);
  throw new Error(`${at}: object/array const values are not supported.`);
}

function rangeStatus(status: string): string {
  const start = Number(status[0]) * 100;
  return `Extract<HttpStatus, ${Array.from({ length: 100 }, (_, i) => start + i).join(' | ')}>`;
}

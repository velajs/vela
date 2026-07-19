/**
 * A defensive narrowing layer over `app.openapi` (whose wire type is `unknown`).
 * These local shapes are NOT wire types — they are the UI's read model of a
 * possibly-malformed OpenAPI document, so every accessor tolerates missing or
 * wrong-typed fields rather than trusting the payload.
 */

export interface OpenApiParameter {
  name: string;
  in: string;
  required: boolean;
  schema?: unknown;
}

export interface OpenApiResponse {
  status: string;
  description?: string;
}

export interface OpenApiOperation {
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  tags: string[];
  parameters: OpenApiParameter[];
  requestBody?: unknown;
  responses: OpenApiResponse[];
}

export interface OpenApiInfo {
  title: string;
  version: string;
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseParameters(value: unknown): OpenApiParameter[] {
  if (!Array.isArray(value)) return [];
  const out: OpenApiParameter[] = [];
  for (const raw of value) {
    const rec = asRecord(raw);
    const name = asString(rec?.name);
    const location = asString(rec?.in);
    if (name === undefined || location === undefined) continue;
    out.push({ name, in: location, required: rec?.required === true, schema: rec?.schema });
  }
  return out;
}

function parseResponses(value: unknown): OpenApiResponse[] {
  const rec = asRecord(value);
  if (rec === undefined) return [];
  return Object.entries(rec)
    .map(([status, body]) => ({ status, description: asString(asRecord(body)?.description) }))
    .toSorted((a, b) => a.status.localeCompare(b.status));
}

/** Extract the API title/version, defaulting when absent. */
export function readInfo(doc: unknown): OpenApiInfo {
  const info = asRecord(asRecord(doc)?.info);
  return {
    title: asString(info?.title) ?? 'API',
    version: asString(info?.version) ?? '—',
  };
}

/** Flatten the document's paths into a list of operations. */
export function readOperations(doc: unknown): OpenApiOperation[] {
  const paths = asRecord(asRecord(doc)?.paths);
  if (paths === undefined) return [];
  const operations: OpenApiOperation[] = [];
  for (const [path, pathItemRaw] of Object.entries(paths)) {
    const pathItem = asRecord(pathItemRaw);
    if (pathItem === undefined) continue;
    for (const method of HTTP_METHODS) {
      const opRaw = pathItem[method];
      const op = asRecord(opRaw);
      if (op === undefined) continue;
      const tags = Array.isArray(op.tags)
        ? op.tags.filter((t): t is string => typeof t === 'string')
        : [];
      operations.push({
        method: method.toUpperCase(),
        path,
        operationId: asString(op.operationId),
        summary: asString(op.summary),
        tags,
        parameters: parseParameters(op.parameters),
        requestBody: op.requestBody,
        responses: parseResponses(op.responses),
      });
    }
  }
  return operations;
}

/** Group operations by their first tag (or `untagged`), tags sorted. */
export function groupByTag(operations: OpenApiOperation[]): Array<[string, OpenApiOperation[]]> {
  const groups = new Map<string, OpenApiOperation[]>();
  for (const op of operations) {
    const tag = op.tags[0] ?? 'untagged';
    const bucket = groups.get(tag);
    if (bucket === undefined) groups.set(tag, [op]);
    else bucket.push(op);
  }
  return [...groups.entries()].toSorted((a, b) => a[0].localeCompare(b[0]));
}

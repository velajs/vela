/** OpenAPI reference and local host HTTP explorer. Worker authorization gates execution. */
import { useMutation } from '@tanstack/react-query';
import { parseTryItRequest } from '@velajs/studio-protocol';
import { useAdminClient } from '../../data/context';
import { toAdminError } from '../../client/admin-client';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useStudioCapabilities } from '../../data/capabilities';
import { useAdminQuery } from '../../data/query';
import { Panel, QueryView, Badge, JsonBlock } from '../shared';
import type { BadgeTone } from '../shared';
import { groupByTag, readInfo, readOperations } from './openapi';
import type { OpenApiOperation } from './openapi';

const METHOD_TONE: Record<string, BadgeTone> = {
  GET: 'success',
  POST: 'accent',
  PUT: 'warn',
  PATCH: 'warn',
  DELETE: 'danger',
};

function opKey(op: OpenApiOperation): string {
  return `${op.method} ${op.path}`;
}

function TryIt({
  operation,
  canExecute,
}: {
  operation: OpenApiOperation;
  canExecute: boolean;
}): ReactNode {
  const [body, setBody] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [headersText, setHeadersText] = useState('{}');
  const [formError, setFormError] = useState<string | null>(null);
  const client = useAdminClient();
  const mutation = useMutation({
    mutationFn: async (args: ReturnType<typeof parseTryItRequest>) => {
      if (client === undefined) throw new Error('Connect through the local Studio host.');
      return client.tryIt(args);
    },
  });
  const pathNames = [...operation.path.matchAll(/\{([^}]+)\}/g)].flatMap((match) =>
    match[1] ? [match[1]] : [],
  );
  const parameters = [
    ...pathNames.map((name) => ({ name, in: 'path', required: true })),
    ...operation.parameters.filter(
      (parameter) => parameter.in === 'query' || parameter.in === 'header',
    ),
  ];

  const execute = (): void => {
    let parsedBody: unknown;
    if (body.trim() !== '') {
      try {
        parsedBody = JSON.parse(body);
      } catch {
        parsedBody = body;
      }
    }
    try {
      let path = operation.path;
      const query: Record<string, string> = {};
      const extraHeaders: Record<string, string> = {};
      for (const parameter of parameters) {
        const value = values[`${parameter.in}:${parameter.name}`] ?? '';
        if (parameter.required && !value) throw new Error(`Enter ${parameter.name}.`);
        if (parameter.in === 'path')
          path = path.replaceAll(`{${parameter.name}}`, encodeURIComponent(value));
        else if (parameter.in === 'query' && value) query[parameter.name] = value;
        else if (parameter.in === 'header' && value) extraHeaders[parameter.name] = value;
      }
      const args = parseTryItRequest({
        method: operation.method,
        path,
        query,
        headers: JSON.parse(headersText),
        body: parsedBody,
      });
      args.headers = { ...args.headers, ...extraHeaders };
      setFormError(null);
      mutation.mutate(args);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Invalid request.');
    }
  };

  return (
    <div className="vela-tryit">
      <h3 className="vela-tryit__title">Try it</h3>
      {parameters.map((parameter) => (
        <label key={`${parameter.in}:${parameter.name}`}>
          {parameter.name} ({parameter.in})
          <input
            aria-label={`${parameter.name} (${parameter.in})`}
            className="vela-input"
            value={values[`${parameter.in}:${parameter.name}`] ?? ''}
            onChange={(event) =>
              setValues({ ...values, [`${parameter.in}:${parameter.name}`]: event.target.value })
            }
          />
        </label>
      ))}
      <textarea
        className="vela-textarea"
        aria-label="API headers (JSON)"
        value={headersText}
        onChange={(event) => setHeadersText(event.target.value)}
      />
      {operation.method !== 'GET' ? (
        <textarea
          className="vela-textarea"
          aria-label="Request body (JSON)"
          placeholder='{ "key": "value" }'
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
      ) : null}
      {canExecute ? (
        <button
          type="button"
          className="vela-btn vela-btn--primary"
          onClick={execute}
          disabled={mutation.isPending}
        >
          Execute
        </button>
      ) : (
        <p className="vela-note">
          Read-only Studio or no local host connection — execution is disabled.
        </p>
      )}
      {formError ? <p role="alert">{formError}</p> : null}
      {mutation.error !== null ? (
        <p className="vela-state__message" role="alert">
          {toAdminError(mutation.error).body.message}
        </p>
      ) : null}
      {mutation.data !== undefined ? (
        <div className="vela-tryit__result">
          <Badge tone={mutation.data.status < 400 ? 'success' : 'danger'}>
            {mutation.data.status}
          </Badge>
          <JsonBlock value={mutation.data.body} />
        </div>
      ) : null}
    </div>
  );
}

function OperationDetail({
  operation,
  canExecute,
}: {
  operation: OpenApiOperation;
  canExecute: boolean;
}): ReactNode {
  return (
    <div className="vela-op">
      <div className="vela-op__head">
        <Badge tone={METHOD_TONE[operation.method] ?? 'neutral'}>{operation.method}</Badge>
        <span className="vela-op__path vela-mono">{operation.path}</span>
      </div>
      {operation.summary !== undefined ? (
        <p className="vela-op__summary">{operation.summary}</p>
      ) : null}

      <h3 className="vela-op__section">Parameters</h3>
      {operation.parameters.length === 0 ? (
        <p className="vela-state__hint">None.</p>
      ) : (
        <table className="vela-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>In</th>
              <th>Required</th>
              <th>Schema</th>
            </tr>
          </thead>
          <tbody>
            {operation.parameters.map((param) => (
              <tr key={`${param.in}-${param.name}`}>
                <td className="vela-mono">{param.name}</td>
                <td>{param.in}</td>
                <td>{param.required ? 'yes' : 'no'}</td>
                <td>{param.schema !== undefined ? <JsonBlock value={param.schema} /> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {operation.requestBody !== undefined ? (
        <>
          <h3 className="vela-op__section">Request body</h3>
          <JsonBlock value={operation.requestBody} />
        </>
      ) : null}

      <h3 className="vela-op__section">Responses</h3>
      {operation.responses.length === 0 ? (
        <p className="vela-state__hint">None documented.</p>
      ) : (
        <ul className="vela-op__responses">
          {operation.responses.map((response) => (
            <li key={response.status}>
              <Badge tone={Number(response.status) < 400 ? 'success' : 'warn'}>
                {response.status}
              </Badge>
              <span>{response.description ?? ''}</span>
            </li>
          ))}
        </ul>
      )}

      <TryIt key={opKey(operation)} operation={operation} canExecute={canExecute} />
    </div>
  );
}

function ApiReference({ doc, canExecute }: { doc: unknown; canExecute: boolean }): ReactNode {
  const info = useMemo(() => readInfo(doc), [doc]);
  const operations = useMemo(() => readOperations(doc), [doc]);
  const groups = useMemo(() => groupByTag(operations), [operations]);
  const [selected, setSelected] = useState<string | null>(
    operations[0] ? opKey(operations[0]) : null,
  );

  if (operations.length === 0) {
    return <p className="vela-state__hint">The document declares no operations.</p>;
  }
  const current = operations.find((op) => opKey(op) === selected) ?? operations[0];

  return (
    <div className="vela-api">
      <aside className="vela-api__nav" aria-label="Operations">
        <div className="vela-api__info">
          {info.title} <Badge tone="muted">{info.version}</Badge>
        </div>
        {groups.map(([tag, ops]) => (
          <div className="vela-api__group" key={tag}>
            <span className="vela-api__group-label">{tag}</span>
            <ul className="vela-api__ops">
              {ops.map((op) => (
                <li key={opKey(op)}>
                  <button
                    type="button"
                    className="vela-api__op"
                    data-active={opKey(op) === opKey(current) ? 'true' : undefined}
                    onClick={() => setSelected(opKey(op))}
                  >
                    <Badge tone={METHOD_TONE[op.method] ?? 'neutral'}>{op.method}</Badge>
                    <span className="vela-mono">{op.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </aside>
      <div className="vela-api__detail">
        <OperationDetail operation={current} canExecute={canExecute} />
      </div>
    </div>
  );
}

export default function ApiPanel(): ReactNode {
  const { capabilities } = useStudioCapabilities();
  const client = useAdminClient();
  const canExecute =
    capabilities.writes.opsEditable &&
    capabilities.operations.includes('api.authorizeTryIt') &&
    client?.apiRequestPath !== undefined;
  const result = useAdminQuery('app.openapi', {});
  return (
    <Panel title="API Explorer" description="The app's OpenAPI reference, with an optional try-it.">
      <QueryView result={result}>
        {(doc) => <ApiReference doc={doc} canExecute={canExecute} />}
      </QueryView>
    </Panel>
  );
}

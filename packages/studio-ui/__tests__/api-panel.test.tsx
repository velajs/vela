import { AdminClient } from '../src/client/admin-client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  capabilitiesReadOnly,
  FakeAdminTransport,
  fakeTable,
  makeErrorBody,
} from '@velajs/studio-fixtures';
import { AdminClientProvider } from '../src/data/context';
import ApiPanel from '../src/panels/api/index';

afterEach(cleanup);

function mount(ui: ReactElement, transport: FakeAdminTransport, client?: AdminClient): void {
  render(
    <AdminClientProvider transport={transport} client={client}>
      {ui}
    </AdminClientProvider>,
  );
}

describe('api panel', () => {
  it('renders the OpenAPI reference grouped by operation', async () => {
    mount(<ApiPanel />, new FakeAdminTransport(fakeTable()));
    expect(await screen.findByText('Example API')).toBeTruthy();
    expect(await screen.findByText('List users')).toBeTruthy();
    expect(screen.getByText('Try it')).toBeTruthy();
  });

  it('hides the execute affordance when opsEditable is false', async () => {
    mount(
      <ApiPanel />,
      new FakeAdminTransport(fakeTable({ 'studio.capabilities': capabilitiesReadOnly })),
    );
    await screen.findByText('Try it');
    expect(screen.queryByRole('button', { name: 'Execute' })).toBeNull();
    expect(screen.getByText(/Read-only Studio/)).toBeTruthy();
  });

  it('executes through the host endpoint with the local session', async () => {
    const requests: Request[] = [];
    const client = new AdminClient({
      baseUrl: 'http://localhost',
      basePath: '/custom/admin',
      adminToken: 'session',
      apiRequestPath: '/custom/admin/api-request',
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ status: 200, headers: {}, body: { echo: true } });
      },
    });
    mount(<ApiPanel />, new FakeAdminTransport(fakeTable()), client);
    fireEvent.click(await screen.findByRole('button', { name: 'Execute' }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].url).toBe('http://localhost/custom/admin/api-request');
    expect(requests[0].headers.get('authorization')).toBe('Bearer session');
    expect(await screen.findByText((content) => content.includes('"echo"'))).toBeTruthy();
  });

  it('resolves inherited path/query parameters and explicit headers before execution', async () => {
    const requests: Request[] = [];
    const client = new AdminClient({
      baseUrl: 'http://localhost',
      apiRequestPath: '/admin/api-request',
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ status: 200, headers: {}, body: null });
      },
    });
    mount(
      <ApiPanel />,
      new FakeAdminTransport(
        fakeTable({
          'app.openapi': {
            paths: {
              '/users/{id}': {
                parameters: [{ name: 'q', in: 'query', required: false }],
                get: { responses: { 200: {} } },
              },
            },
          },
        }),
      ),
      client,
    );
    const execute = await screen.findByRole('button', { name: 'Execute' });
    fireEvent.click(execute);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Enter id.');
    expect(requests).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('id (path)'), { target: { value: 'a/b' } });
    fireEvent.change(screen.getByLabelText('q (query)'), { target: { value: 'hello world' } });
    fireEvent.change(screen.getByLabelText('API headers (JSON)'), {
      target: { value: '{"authorization":"Bearer USER"}' },
    });
    fireEvent.click(execute);
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(await requests[0].json()).toMatchObject({
      method: 'GET',
      path: '/users/a%2Fb',
      query: { q: 'hello world' },
      headers: { authorization: 'Bearer USER' },
    });
  });

  it('keeps execution unavailable without a local host connection', async () => {
    mount(<ApiPanel />, new FakeAdminTransport(fakeTable()));
    await screen.findByText('Try it');
    expect(screen.queryByRole('button', { name: 'Execute' })).toBeNull();
  });

  it('renders the degraded state when the OpenAPI document is unconfigured', async () => {
    const transport = new FakeAdminTransport(fakeTable(), {
      errors: { 'app.openapi': makeErrorBody('FEATURE_UNCONFIGURED', 404) },
    });
    mount(<ApiPanel />, transport);
    expect(await screen.findByText('Not configured')).toBeTruthy();
  });
});

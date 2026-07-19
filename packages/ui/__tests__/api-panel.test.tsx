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

function mount(ui: ReactElement, transport: FakeAdminTransport): void {
  render(<AdminClientProvider transport={transport}>{ui}</AdminClientProvider>);
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

  it('executes a try-it request when opsEditable is open', async () => {
    const transport = new FakeAdminTransport(fakeTable());
    mount(<ApiPanel />, transport);
    fireEvent.click(await screen.findByRole('button', { name: 'Execute' }));
    await waitFor(() => expect(transport.calls.some((c) => c.op === 'api.tryit')).toBe(true));
    // The echoed response body is unique to the try-it result panel.
    expect(await screen.findByText((content) => content.includes('"echo"'))).toBeTruthy();
  });

  it('renders the degraded state when the OpenAPI document is unconfigured', async () => {
    const transport = new FakeAdminTransport(fakeTable(), {
      errors: { 'app.openapi': makeErrorBody('FEATURE_UNCONFIGURED', 404) },
    });
    mount(<ApiPanel />, transport);
    expect(await screen.findByText('Not configured')).toBeTruthy();
  });
});

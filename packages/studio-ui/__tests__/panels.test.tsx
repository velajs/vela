import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  capabilitiesAllOn,
  capabilitiesReadOnly,
  FakeAdminTransport,
  fakeTable,
  makeErrorBody,
} from '@velajs/studio-fixtures';
import { AdminClientProvider } from '../src/data/context';
import RoutesPanel from '../src/panels/routes';
import ModulesPanel from '../src/panels/modules';
import EntrypointsPanel from '../src/panels/entrypoints';
import OrganizationsPanel from '../src/panels/organizations';
import LivePanel from '../src/panels/live';
import PresencePanel from '../src/panels/presence';
import AuditPanel from '../src/panels/audit';
import FlagsPanel from '../src/panels/flags';
import LogsPanel from '../src/panels/logs';
import UsersPanel from '../src/panels/users';
import SessionsPanel from '../src/panels/sessions';
import QueuesPanel from '../src/panels/queues';
import SchedulePanel from '../src/panels/schedule';

afterEach(cleanup);

function mount(ui: ReactElement, transport: FakeAdminTransport): void {
  render(<AdminClientProvider transport={transport}>{ui}</AdminClientProvider>);
}

const forbidden = makeErrorBody('STUDIO_OP_FORBIDDEN', 403, { hint: 'read-only-marker' });

interface SimpleCase {
  label: string;
  element: ReactElement;
  op: Parameters<FakeAdminTransport['setResponder']>[0];
  empty: unknown;
  emptyLabel: string;
  sample: string;
}

const SIMPLE_CASES: SimpleCase[] = [
  {
    label: 'routes',
    element: <RoutesPanel />,
    op: 'app.routes',
    empty: [],
    emptyLabel: 'No routes.',
    sample: '/health',
  },
  {
    label: 'modules',
    element: <ModulesPanel />,
    op: 'app.modules',
    empty: [],
    emptyLabel: 'No modules.',
    sample: 'AppModule',
  },
  {
    label: 'entrypoints',
    element: <EntrypointsPanel />,
    op: 'app.entrypoints',
    empty: [],
    emptyLabel: 'No entrypoints.',
    sample: 'EmailQueue#process',
  },
  {
    label: 'organizations',
    element: <OrganizationsPanel />,
    op: 'auth.organizations',
    empty: [],
    emptyLabel: 'No organizations.',
    sample: 'Acme, Inc.',
  },
  {
    label: 'live',
    element: <LivePanel />,
    op: 'live.subscriptions',
    empty: [],
    emptyLabel: 'No active subscriptions.',
    sample: 'chat:general',
  },
  {
    label: 'presence',
    element: <PresencePanel />,
    op: 'presence.rooms',
    empty: [],
    emptyLabel: 'No occupied rooms.',
    sample: 'chat:general',
  },
  {
    label: 'audit',
    element: <AuditPanel />,
    op: 'audit.tail',
    empty: [],
    emptyLabel: 'No audit rows.',
    sample: 'auth.revokeSession',
  },
  {
    label: 'flags',
    element: <FlagsPanel />,
    op: 'flags.list',
    empty: [],
    emptyLabel: 'No flags.',
    sample: 'new-dashboard',
  },
  {
    label: 'logs',
    element: <LogsPanel />,
    op: 'logs.tail',
    empty: [],
    emptyLabel: 'No log lines.',
    sample: 'server started',
  },
];

describe.each(SIMPLE_CASES)('$label panel', ({ element, op, empty, emptyLabel, sample }) => {
  it('renders with data', async () => {
    mount(element, new FakeAdminTransport(fakeTable()));
    expect(await screen.findByText(sample)).toBeTruthy();
  });

  it('renders the empty state', async () => {
    mount(element, new FakeAdminTransport(fakeTable({ [op]: empty })));
    expect(await screen.findByText(emptyLabel)).toBeTruthy();
  });

  it('renders the error state (hint + docs off the wire body)', async () => {
    mount(element, new FakeAdminTransport(fakeTable(), { errors: { [op]: forbidden } }));
    expect(await screen.findByText('read-only-marker')).toBeTruthy();
  });
});

describe('users panel', () => {
  it('renders rows and opens the detail drawer', async () => {
    const transport = new FakeAdminTransport(fakeTable());
    mount(<UsersPanel />, transport);
    const row = await screen.findByText('ada@example.com');
    fireEvent.click(row);
    const dialog = await screen.findByRole('dialog', { name: 'User' });
    expect(await within(dialog).findByText('ada@example.com')).toBeTruthy();
    expect(transport.calls.some((c) => c.op === 'auth.userDetail')).toBe(true);
  });

  it('passes the search box query to auth.users', async () => {
    const transport = new FakeAdminTransport(fakeTable());
    mount(<UsersPanel />, transport);
    await screen.findByText('ada@example.com');
    fireEvent.change(screen.getByLabelText('Search users'), { target: { value: 'grace' } });
    await waitFor(() =>
      expect(
        transport.calls.some(
          (c) => c.op === 'auth.users' && (c.args as { q?: string }).q === 'grace',
        ),
      ).toBe(true),
    );
  });

  it('renders the empty state', async () => {
    mount(<UsersPanel />, new FakeAdminTransport(fakeTable({ 'auth.users': { rows: [] } })));
    expect(await screen.findByText('No users match.')).toBeTruthy();
  });
});

describe('sessions panel (write gating)', () => {
  it('shows a revoke button when opsEditable is open', async () => {
    mount(<SessionsPanel />, new FakeAdminTransport(fakeTable()));
    expect((await screen.findAllByRole('button', { name: 'Revoke' })).length).toBeGreaterThan(0);
  });

  it('hides the revoke button in a read-only Studio', async () => {
    mount(
      <SessionsPanel />,
      new FakeAdminTransport(fakeTable({ 'studio.capabilities': capabilitiesReadOnly })),
    );
    await screen.findByText('s_1');
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
  });

  it('calls auth.revokeSession on click', async () => {
    const transport = new FakeAdminTransport(fakeTable());
    mount(<SessionsPanel />, transport);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Revoke' }))[0]);
    await waitFor(() =>
      expect(transport.calls.some((c) => c.op === 'auth.revokeSession')).toBe(true),
    );
  });
});

describe('queues panel', () => {
  it('renders queues and opens the dead-letter drawer', async () => {
    const transport = new FakeAdminTransport(fakeTable());
    mount(<QueuesPanel />, transport);
    await screen.findByText('email');
    fireEvent.click(
      within(screen.getByText('email').closest('tr') as HTMLElement).getByRole('button', {
        name: 'Dead letters',
      }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('dlq_1')).toBeTruthy();
  });

  it('hides send affordances in a read-only Studio', async () => {
    mount(
      <QueuesPanel />,
      new FakeAdminTransport(fakeTable({ 'studio.capabilities': capabilitiesReadOnly })),
    );
    await screen.findByText('email');
    expect(screen.queryByRole('button', { name: 'Send test' })).toBeNull();
  });
});

describe('schedule panel', () => {
  it('renders jobs and triggers', async () => {
    mount(<SchedulePanel />, new FakeAdminTransport(fakeTable()));
    expect(await screen.findByText('ReportJob.run')).toBeTruthy();
    expect(await screen.findByText('nightly-rollup')).toBeTruthy();
  });

  it('gates run-now behind opsEditable', async () => {
    mount(
      <SchedulePanel />,
      new FakeAdminTransport(fakeTable({ 'studio.capabilities': capabilitiesReadOnly })),
    );
    await screen.findByText('ReportJob.run');
    expect(screen.queryByRole('button', { name: 'Run now' })).toBeNull();
  });
});

describe('flags panel evaluate drawer', () => {
  it('evaluates a flag against a targeting context', async () => {
    const transport = new FakeAdminTransport(fakeTable());
    mount(<FlagsPanel />, transport);
    await screen.findByText('new-dashboard');
    fireEvent.click(
      within(screen.getByText('new-dashboard').closest('tr') as HTMLElement).getByRole('button', {
        name: 'Evaluate',
      }),
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Evaluate' }));
    await waitFor(() => expect(transport.calls.some((c) => c.op === 'flags.evaluate')).toBe(true));
    expect(within(dialog).getByText('STATIC')).toBeTruthy();
  });
});

describe('capabilities re-export sanity', () => {
  it('read-only variant lights features but closes gates', () => {
    expect(capabilitiesReadOnly.features.auth).toBe(true);
    expect(capabilitiesReadOnly.writes.opsEditable).toBe(false);
    expect(capabilitiesAllOn.writes.opsEditable).toBe(true);
  });
});

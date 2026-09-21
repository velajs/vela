import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { FakeAdminTransport, fakeTable } from '@velajs/studio-fixtures';
import { renderWithAdmin } from './helpers';
import LogsPanel from '../src/panels/logs';
import ModulesPanel from '../src/panels/modules';
import EntrypointsPanel from '../src/panels/entrypoints';

afterEach(cleanup);

it('explains the timing boundary and invocation owner', async () => {
  renderWithAdmin(
    <LogsPanel />,
    new FakeAdminTransport(
      fakeTable({
        'logs.tail': [
          {
            ts: 1,
            level: 'info',
            msg: 'Handler returned',
            invocation: {
              kind: 'queue',
              source: 'Emails#send',
              moduleId: 'mail-module',
              invocationId: 'inv-1',
              elapsedMs: 12.5,
              outcome: 'returned',
              boundary: 'handler',
            },
          },
        ],
      }),
    ),
  );
  fireEvent.click(await screen.findByText('Handler returned'));
  expect(screen.getByText('12.50 ms')).toBeTruthy();
  expect(screen.getByText(/Invocation: inv-1; owner: mail-module/)).toBeTruthy();
  expect(
    screen.getByText(/Excludes guards, argument validation, response streaming and deferred work/),
  ).toBeTruthy();
});

it('explains the class-token scope snapshot', async () => {
  renderWithAdmin(
    <ModulesPanel />,
    new FakeAdminTransport(
      fakeTable({
        'app.modules': [
          {
            moduleId: 'mail-module',
            imports: [],
            providers: ['Emails'],
            exports: [],
            isGlobal: false,
            lazy: true,
            providerScopes: [{ token: 'Emails', scope: 'request' }],
          },
        ],
      }),
    ),
  );
  fireEvent.click(await screen.findByText('mail-module'));
  expect(screen.getByText('request')).toBeTruthy();
  expect(screen.getByText(/Only registrations with class tokens are listed/)).toBeTruthy();
});

it('renders exact entrypoint ownership and lifetime', async () => {
  renderWithAdmin(
    <EntrypointsPanel />,
    new FakeAdminTransport(
      fakeTable({
        'app.entrypoints': [
          {
            kind: 'queue',
            target: 'Emails#send',
            moduleId: 'mail-module',
            scope: 'request',
          },
        ],
      }),
    ),
  );
  expect(await screen.findByText('mail-module')).toBeTruthy();
  expect(screen.getByText('request')).toBeTruthy();
});

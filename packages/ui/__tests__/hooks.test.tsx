import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  capabilitiesDegraded,
  FakeAdminTransport,
  fakeTable,
  makeErrorBody,
} from '../../fixtures/src/index';
import { useAdminMutation, useAdminQuery } from '../src/data/query';
import { useStudioCapabilities } from '../src/data/capabilities';
import { AdminClientProvider } from '../src/data/context';
import { wrapperFor } from './helpers';

afterEach(cleanup);

describe('useAdminQuery', () => {
  it('resolves canned data and a null error', async () => {
    const transport = new FakeAdminTransport(fakeTable());
    const { result } = renderHook(() => useAdminQuery('app.routes', {}), {
      wrapper: wrapperFor(transport),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toHaveLength(4);
    expect(result.current.error).toBeNull();
  });

  it('surfaces an AdminError with the wire body on failure', async () => {
    const transport = new FakeAdminTransport(fakeTable(), {
      errors: { 'app.routes': makeErrorBody('STUDIO_OP_FORBIDDEN', 403, { hint: 'read-only' }) },
    });
    const { result } = renderHook(() => useAdminQuery('app.routes', {}), {
      wrapper: wrapperFor(transport),
    });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.status).toBe(403);
    expect(result.current.error?.body.hint).toBe('read-only');
    expect(result.current.data).toBeUndefined();
  });
});

function MutationHarness() {
  const query = useAdminQuery('app.routes', {});
  const mutation = useAdminMutation('auth.revokeSession', { invalidates: ['app.routes'] });
  return (
    <div>
      <span data-testid="routes">{query.data?.length ?? 0}</span>
      <button type="button" onClick={() => mutation.mutate({ sessionId: 's_1' })}>
        revoke
      </button>
    </div>
  );
}

describe('useAdminMutation', () => {
  it('invalidates the listed ops after a successful write', async () => {
    const transport = new FakeAdminTransport(fakeTable());

    render(
      <AdminClientProvider transport={transport}>
        <MutationHarness />
      </AdminClientProvider>,
    );

    const routesCalls = () => transport.calls.filter((call) => call.op === 'app.routes').length;
    await waitFor(() => expect(routesCalls()).toBe(1));

    fireEvent.click(screen.getByRole('button', { name: 'revoke' }));

    await waitFor(() =>
      expect(transport.calls.some((call) => call.op === 'auth.revokeSession')).toBe(true),
    );
    await waitFor(() => expect(routesCalls()).toBe(2));
  });
});

describe('useStudioCapabilities (defaults-shown)', () => {
  it('shows every feature and closes every write gate while loading', () => {
    const transport = new FakeAdminTransport({
      'studio.capabilities': () => new Promise(() => {}),
    });
    const { result } = renderHook(() => useStudioCapabilities(), {
      wrapper: wrapperFor(transport),
    });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.capabilities.features.data).toBe(true);
    expect(result.current.capabilities.features.timeTravel).toBe(true);
    expect(result.current.capabilities.writes.dataEditable).toBe(false);
    expect(result.current.capabilities.timeTravel).toBeNull();
  });

  it('reflects the resolved capabilities once loaded', async () => {
    const transport = new FakeAdminTransport({ 'studio.capabilities': capabilitiesDegraded });
    const { result } = renderHook(() => useStudioCapabilities(), {
      wrapper: wrapperFor(transport),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.capabilities.features.data).toBe(false);
    expect(result.current.capabilities.timeTravel).toBeNull();
  });
});

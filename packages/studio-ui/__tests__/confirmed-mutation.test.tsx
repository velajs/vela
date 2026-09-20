import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeAdminTransport, fakeTable, makeErrorBody } from '@velajs/studio-fixtures';
import { readConfirmChallenge, useConfirmedMutation } from '../src/data/use-confirmed-mutation';
import { AdminError } from '../src/client/admin-client';
import { wrapperFor } from './helpers';

afterEach(cleanup);

describe('readConfirmChallenge', () => {
  it('decodes a well-formed 428 challenge', () => {
    const error = new AdminError(
      makeErrorBody('STUDIO_CONFIRM_REQUIRED', 428, {
        details: { confirmToken: 't1', expiresAt: 1_767_225_600_000, summary: 'do it' },
      }),
    );
    expect(readConfirmChallenge(error)).toEqual({
      confirmToken: 't1',
      summary: 'do it',
      expiresAt: 1_767_225_600_000,
    });
  });

  it('returns null when expiresAt is not a number (protocol shape guard)', () => {
    const error = new AdminError(
      makeErrorBody('STUDIO_CONFIRM_REQUIRED', 428, {
        details: { confirmToken: 't1', expiresAt: '2026-01-01T00:00:00.000Z', summary: 'do it' },
      }),
    );
    expect(readConfirmChallenge(error)).toBeNull();
  });

  it('returns null for a non-428 error', () => {
    const error = new AdminError(makeErrorBody('STUDIO_OP_FORBIDDEN', 403));
    expect(readConfirmChallenge(error)).toBeNull();
  });

  it('returns null when the 428 details are malformed', () => {
    const error = new AdminError(
      makeErrorBody('STUDIO_CONFIRM_REQUIRED', 428, { details: { summary: 'no token' } }),
    );
    expect(readConfirmChallenge(error)).toBeNull();
  });
});

describe('useConfirmedMutation', () => {
  it('challenges on 428, then confirms and re-fires with the token', async () => {
    const transport = new FakeAdminTransport(fakeTable());
    const { result } = renderHook(
      () => useConfirmedMutation('data.deleteRows', { invalidates: ['data.listRows'] }),
      { wrapper: wrapperFor(transport) },
    );

    act(() => {
      result.current.mutate({
        model: 'user',
        ids: ['u_001', 'u_002'],
        mode: 'hard',
        confirmToken: '',
      });
    });

    await waitFor(() => expect(result.current.pendingConfirm).not.toBeNull());
    expect(result.current.pendingConfirm?.summary).toBe('hard-delete 2 rows from user');
    expect(result.current.error).toBeNull();
    expect(result.current.data).toBeUndefined();

    act(() => {
      result.current.confirm();
    });

    await waitFor(() => expect(result.current.data).toEqual({ deleted: 2 }));
    expect(result.current.pendingConfirm).toBeNull();

    // The retry carried the token minted by the first (challenged) call.
    const deletes = transport.calls.filter((c) => c.op === 'data.deleteRows');
    expect(deletes).toHaveLength(2);
    const retry = deletes[1].args as { confirmToken: string; ids: string[] };
    expect(retry.confirmToken).not.toBe('');
    expect(retry.ids).toEqual(['u_001', 'u_002']);
  });

  it('passes a non-428 error straight through without a dialog', async () => {
    const transport = new FakeAdminTransport(fakeTable(), {
      errors: {
        'data.deleteRows': makeErrorBody('STUDIO_OP_FORBIDDEN', 403, { hint: 'read-only' }),
      },
    });
    const { result } = renderHook(() => useConfirmedMutation('data.deleteRows'), {
      wrapper: wrapperFor(transport),
    });

    act(() => {
      result.current.mutate({ model: 'user', ids: ['u_001'], mode: 'hard', confirmToken: '' });
    });

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.status).toBe(403);
    expect(result.current.error?.hint).toBe('read-only');
    expect(result.current.pendingConfirm).toBeNull();
  });

  it('cancel aborts the pending confirmation with no retry', async () => {
    const transport = new FakeAdminTransport(fakeTable());
    const { result } = renderHook(() => useConfirmedMutation('data.clearTable'), {
      wrapper: wrapperFor(transport),
    });

    act(() => {
      result.current.mutate({ model: 'post', confirmToken: '' });
    });

    await waitFor(() => expect(result.current.pendingConfirm).not.toBeNull());

    act(() => {
      result.current.cancel();
    });

    expect(result.current.pendingConfirm).toBeNull();
    expect(result.current.data).toBeUndefined();
    // Exactly one clearTable call — the initial challenge, never a confirm.
    expect(transport.calls.filter((c) => c.op === 'data.clearTable')).toHaveLength(1);
  });
});

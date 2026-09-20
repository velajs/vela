import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../src/panels/shared';

afterEach(cleanup);

describe('ConfirmDialog — a11y (focus trap + Escape)', () => {
  it('moves focus into the dialog on open', () => {
    render(
      <ConfirmDialog pending={{ summary: 'delete it' }} onConfirm={() => {}} onCancel={() => {}} />,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('Escape routes to Cancel', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        pending={{ summary: 'delete it' }}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('renders nothing (and traps nothing) when closed', () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog pending={null} onConfirm={() => {}} onCancel={onCancel} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
  });
});

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StudioColumn } from '@velajs/studio-protocol';
import { RowForm } from '../src/panels/data/row-form';

afterEach(cleanup);

function col(
  name: string,
  type: StudioColumn['type'],
  extra: Partial<StudioColumn> = {},
): StudioColumn {
  return { name, type, pk: false, nullable: false, unique: false, managed: false, ...extra };
}

// id is a read-only pk; name is required; bio + age are nullable and OFTEN absent
// from a given row — the exact shape that used to get null-patched by mistake.
const columns: StudioColumn[] = [
  col('id', 'string', { pk: true, unique: true }),
  col('name', 'string'),
  col('bio', 'string', { nullable: true }),
  col('age', 'number', { nullable: true }),
];

describe('RowForm — the edit patch is minimal (M7b null-over-eager fix)', () => {
  it('sends EXACTLY the changed field; untouched nullable columns are not nulled', () => {
    const onSubmit = vi.fn();
    render(
      <RowForm
        columns={columns}
        mode="edit"
        // bio + age are absent from this row entirely.
        initial={{ id: 'r1', name: 'Ada' }}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );

    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'Grace' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    // The whole point: NOT { name, bio: null, age: null } — only the real change.
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ name: 'Grace' });
  });

  it('emits null only when the user clears a previously-set field', () => {
    const onSubmit = vi.fn();
    render(
      <RowForm
        columns={columns}
        mode="edit"
        initial={{ id: 'r1', name: 'Ada', bio: 'hello' }}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );

    fireEvent.change(screen.getByLabelText('bio'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(onSubmit).toHaveBeenCalledWith({ bio: null });
  });

  it('an untouched form submits an empty patch', () => {
    const onSubmit = vi.fn();
    render(
      <RowForm
        columns={columns}
        mode="edit"
        initial={{ id: 'r1', name: 'Ada', bio: 'hello' }}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(onSubmit).toHaveBeenCalledWith({});
  });
});

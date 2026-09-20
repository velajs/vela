import { describe, expect, it } from 'vitest';
import { defineErrorCatalog, composeCatalogs, CORE_CATALOG } from '../catalog';
import { VelaError } from '../error';
import { toErrorBody } from '../to-error-body';

describe('toErrorBody', () => {
  it('redacts anything unbranded (rule 1)', () => {
    const { body, status, redacted } = toErrorBody(new Error('secret host=10.0.0.5'));
    expect(redacted).toBe(true);
    expect(status).toBe(500);
    expect(body.error.code).toBe('internal');
    expect(body.error.message).not.toContain('10.0.0.5');
  });

  it('redacts the plan-119 foreign error', () => {
    const foreign = Object.assign(new Error('internal driver detail: host=10.0.0.5'), {
      code: 'PROTOCOL_ERROR',
      status: 502,
    });
    const { body, redacted } = toErrorBody(foreign);
    expect(redacted).toBe(true);
    expect(body.error.message).not.toContain('10.0.0.5');
  });

  it('redacts branded errors whose catalog entry is internal (rule 2), keeping code+status', () => {
    const catalog = composeCatalogs(
      CORE_CATALOG,
      defineErrorCatalog({
        db_corruption: { status: 500, title: 'Storage failure', internal: true },
      }),
    );
    const err = new VelaError('db_corruption', {
      status: 500,
      message: 'page 7 checksum mismatch',
    });
    const { body, redacted } = toErrorBody(err, { catalog });
    expect(redacted).toBe(true);
    expect(body.error.code).toBe('db_corruption');
    expect(body.error.message).not.toContain('checksum');
    expect(body.error.details).toBeUndefined();
    expect(body.error.hint).toBeUndefined();
  });

  it('open codes with status 500 still echo (500 alone never redacts)', () => {
    const { body, redacted } = toErrorBody(
      new VelaError('db_x', { status: 500, message: 'app-chosen safe text' }),
    );
    expect(redacted).toBe(false);
    expect(body.error).toStrictEqual({ code: 'db_x', message: 'app-chosen safe text' });
  });

  it('echoes branded non-internal errors — catalogued or open (rule 3)', () => {
    const { body, status, redacted } = toErrorBody(
      new VelaError('order_expired', {
        status: 410,
        message: 'Order 42 expired',
        hint: 'Create a new order.',
        data: { id: 42 },
      }),
    );
    expect(redacted).toBe(false);
    expect(status).toBe(410);
    expect(body.error).toStrictEqual({
      code: 'order_expired',
      message: 'Order 42 expired',
      hint: 'Create a new order.',
      details: { id: 42 },
    });
  });

  it('honors includeHint:false and encodeData', () => {
    const err = new VelaError('conflict', { hint: 'h', data: 7n });
    const { body } = toErrorBody(err, { includeHint: false, encodeData: (d) => String(d) });
    expect(body.error.hint).toBeUndefined();
    expect(body.error.details).toBe('7');
  });

  it('the internal core code is always redacted (invariant channel)', () => {
    const { redacted, body } = toErrorBody(
      new VelaError('internal', { message: 'invariant: cache poisoned' }),
    );
    expect(redacted).toBe(true);
    expect(body.error.message).not.toContain('poisoned');
  });
});

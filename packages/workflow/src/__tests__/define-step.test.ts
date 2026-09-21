import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineStep, isStepDefinition } from '../index';

describe('defineStep', () => {
  it('brands a valid config with isVelaStep and keeps its fields', () => {
    const step = defineStep({
      name: 'charge order',
      args: { orderId: z.string() },
      returns: z.object({ receiptId: z.string() }),
      handler: async (_ctx, { orderId }) => ({ receiptId: `r-${orderId}` }),
    });

    expect(step.isVelaStep).toBe(true);
    expect(step.name).toBe('charge order');
    expect(typeof step.handler).toBe('function');
    expect(step.args.orderId).toBeInstanceOf(z.ZodString);
    expect(isStepDefinition(step)).toBe(true);
  });

  it('throws when the name is empty', () => {
    expect(() => defineStep({ name: '', args: {}, handler: async () => undefined })).toThrow(
      /`name` must be a non-empty string/,
    );
  });

  it('throws when args is not an object', () => {
    expect(() =>
      defineStep({
        name: 'x',
        args: 42 as unknown as Record<string, z.ZodType>,
        handler: async () => undefined,
      }),
    ).toThrow(/`args` must be a map of zod schemas/);
  });

  it('throws when the handler is not a function', () => {
    expect(() => defineStep({ name: 'x', args: {}, handler: 5 as unknown as () => void })).toThrow(
      /`handler` must be a function/,
    );
  });

  it('throws when rollback is provided but not a function', () => {
    expect(() =>
      defineStep({
        name: 'x',
        args: {},
        handler: async () => undefined,
        rollback: 'nope' as unknown as () => void,
      }),
    ).toThrow(/`rollback` must be a function/);
  });
});

describe('isStepDefinition', () => {
  it('rejects non-branded values', () => {
    expect(isStepDefinition(undefined)).toBe(false);
    expect(isStepDefinition({})).toBe(false);
    expect(isStepDefinition({ isVelaStep: false })).toBe(false);
  });
});

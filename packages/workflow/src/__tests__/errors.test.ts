import { describe, expect, it } from 'vitest';

import {
  convertNonRetryableError,
  isNonRetryableError,
  toNativeNonRetryableError,
  WorkflowNonRetryableError,
} from '../index';

describe('WorkflowNonRetryableError', () => {
  it('defaults to the NonRetryableError name and a portable terminal marker', () => {
    const error = new WorkflowNonRetryableError('cannot retry this');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('NonRetryableError');
    expect(error.message).toBe('cannot retry this');
    expect(isNonRetryableError(error)).toBe(true);
  });

  it('allows overriding the name', () => {
    const error = new WorkflowNonRetryableError('boom', 'FatalError');
    expect(error.name).toBe('FatalError');
    expect(isNonRetryableError(error)).toBe(true);
  });
});

describe('isNonRetryableError', () => {
  it('rejects plain errors and non-errors', () => {
    expect(isNonRetryableError(new Error('plain'))).toBe(false);
    expect(isNonRetryableError('NonRetryableError')).toBe(false);
    expect(isNonRetryableError(undefined)).toBe(false);
    expect(isNonRetryableError({ name: 'NonRetryableError' })).toBe(false);
  });
});

describe('convertNonRetryableError', () => {
  it('rethrows the portable error unchanged when no native ctor is supplied (Node path)', () => {
    const portable = new WorkflowNonRetryableError('fatal');
    expect(() => convertNonRetryableError(portable)).toThrowError(portable);
  });

  it('rebuilds it as the native error when a native ctor is supplied', () => {
    class NativeNonRetryable extends Error {
      constructor(message: string, name = 'NonRetryableError') {
        super(message);
        this.name = name;
      }
    }

    const portable = new WorkflowNonRetryableError('fatal', 'CustomName');
    portable.stack = 'STACK-MARKER';

    let thrown: unknown;
    try {
      convertNonRetryableError(portable, NativeNonRetryable);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NativeNonRetryable);
    expect((thrown as Error).name).toBe('CustomName');
    expect((thrown as Error).message).toBe('fatal');
    expect((thrown as Error).stack).toBe('STACK-MARKER');
  });

  it('rethrows a non-workflow error unchanged even with a native ctor', () => {
    class NativeNonRetryable extends Error {}
    const plain = new Error('ordinary');
    expect(() => convertNonRetryableError(plain, NativeNonRetryable)).toThrowError(plain);
  });

  it('preserves cause through native conversion', () => {
    class NativeNonRetryable extends Error {
      constructor(message: string, name = 'NonRetryableError') {
        super(message);
        this.name = name;
      }
    }
    const cause = new Error('root');
    const portable = new WorkflowNonRetryableError('wrap');
    portable.cause = cause;

    const native = toNativeNonRetryableError(portable, NativeNonRetryable);
    expect(native.cause).toBe(cause);
  });
});

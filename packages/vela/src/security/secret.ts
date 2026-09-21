/**
 * Explicitly revealed sensitive value. Runtime-private storage prevents normal
 * enumeration/serialization from exposing the value; this is not encryption.
 */
export class Secret<T> {
  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
    // A data descriptor lets structured loggers redact without invoking code.
    Object.defineProperty(this, Symbol.for('vela.secret'), { value: true });
    Object.freeze(this);
  }

  reveal(): T {
    return this.#value;
  }

  toJSON(): string {
    return '[Redacted]';
  }

  toString(): string {
    return '[Redacted]';
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[Redacted]';
  }
}

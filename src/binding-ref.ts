/**
 * Mutable holder for a Cloudflare binding value.
 *
 * Created by each module's `forRoot()` and populated by
 * CloudflareFactory's one-time middleware on the first request.
 * Services access the binding lazily via `.value`.
 */
export class BindingRef<T = unknown> {
  private _value: T | undefined;

  constructor(public readonly bindingName: string) {}

  get value(): T {
    if (this._value === undefined) {
      throw new Error(
        `Cloudflare binding '${this.bindingName}' not initialized. ` +
          `Ensure CloudflareFactory.create() is used and a request has been made.`,
      );
    }
    return this._value;
  }

  /** @internal — called by CloudflareFactory middleware */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _initialize(value: any): void {
    this._value = value;
  }
}

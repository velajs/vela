/** Node test stand-in; native tests use the platform constructor. */
export class NonRetryableError extends Error {
  constructor(message: string, name = 'NonRetryableError') {
    super(message);
    this.name = name;
  }
}

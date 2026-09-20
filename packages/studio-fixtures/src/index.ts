/**
 * @velajs/studio-fixtures — shared test fixtures for Vela Studio (private).
 *
 * The {@link FakeAdminTransport} implements the same `rpc` seam as the real
 * `AdminClient`; the canned data is typed by `@velajs/studio-protocol` so this
 * package double-guards the wire contract at compile time.
 */
export const STUDIO_FIXTURES_VERSION = '0';

export * from './fake-transport';
export * from './fixtures';
export * from './panel-fixtures';
export * from './data-fixtures';
export * from './time-travel-fixtures';

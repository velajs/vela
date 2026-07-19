/**
 * @velajs/studio-ui — the Vela Studio admin panel UI (React).
 *
 * This root entry is the React surface: the transport (re-exported for
 * convenience; also at `@velajs/studio-ui/client`), the `useAdminQuery` data
 * layer, and the routed shell (`StudioApp`, `Studio`). Panels are placeholder
 * stubs in this milestone — M6 owns the real panel UI.
 */
export const STUDIO_UI_VERSION = '0';

export * from './client/admin-client';
export * from './data';
export * from './shell';

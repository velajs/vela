/**
 * Shared test helpers. `renderWithAdmin` mounts a subtree under a real
 * `<AdminClientProvider>` backed by a `FakeAdminTransport`; `studioFetch` is a
 * record-backed `fetch` fake for exercising the real `AdminClient` end-to-end
 * (health probe + rpc envelopes) without a generic dynamic-dispatch call.
 */
import type { ReactElement, ReactNode } from 'react';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
// The fixtures package is not a declared devDependency of `@velajs/studio-ui`
// (that would need a package.json change out of this task's lane), so tests
// import it by relative source path. See the report's "protocol friction" note.
import {
  capabilitiesAllOn,
  entrypoints,
  FakeAdminTransport,
  flags,
  modules,
  routes,
  scheduleJobs,
} from '../../fixtures/src/index';
import { AdminClientProvider } from '../src/data/context';

export function wrapperFor(transport: FakeAdminTransport) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <AdminClientProvider transport={transport}>{children}</AdminClientProvider>;
  };
}

export function renderWithAdmin(ui: ReactElement, transport: FakeAdminTransport): RenderResult {
  return render(<AdminClientProvider transport={transport}>{ui}</AdminClientProvider>);
}

/** Default op -> canned data used by {@link studioFetch}. */
export const cannedResponses: Record<string, unknown> = {
  'studio.capabilities': capabilitiesAllOn,
  'app.routes': routes,
  'app.modules': modules,
  'app.entrypoints': entrypoints,
  'flags.list': flags,
  'schedule.jobs': scheduleJobs,
};

/**
 * A `fetch` fake speaking the Studio wire protocol: `/health` returns the health
 * probe, `/rpc/:op` wraps the canned response in an ok/err envelope. Records
 * every request so tests can assert on headers (e.g. missing token still sends).
 */
export function studioFetch(options?: {
  responses?: Record<string, unknown>;
  health?: { enabled: boolean; protocolVersion: number };
  requests?: Array<{ url: string; init?: RequestInit }>;
}): typeof fetch {
  const responses = options?.responses ?? cannedResponses;
  const health = options?.health ?? { enabled: true, protocolVersion: 1 };
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    options?.requests?.push({ url, init });
    if (url.endsWith('/health')) {
      return new Response(JSON.stringify(health), { status: 200 });
    }
    const marker = '/rpc/';
    const op = url.slice(url.indexOf(marker) + marker.length);
    if (!(op in responses)) {
      return new Response(
        JSON.stringify({
          ok: false,
          op,
          error: { code: 'STUDIO_UNKNOWN_OP', title: 'Unknown op', status: 404, message: op },
          status: 404,
        }),
        { status: 404 },
      );
    }
    return new Response(
      JSON.stringify({ ok: true, op, data: responses[op], meta: { ms: 1, op, mode: 'read' } }),
      { status: 200 },
    );
  };
  return impl as typeof fetch;
}

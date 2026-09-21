import { afterAll, describe, expect, it } from 'vitest';
import { setupConformance, type AdapterDescriptor } from './contract';

describe('conformance fixture ownership', () => {
  const events: string[] = [];
  const descriptor: AdapterDescriptor = {
    name: 'owned-test-fixture',
    capabilities: { uniqueConstraints: false, timestampKind: 'epoch-ms', relationScoping: false },
    tenant: { field: 'tenantId', headerName: 'X-Tenant-ID', tenantA: 'a', tenantB: 'b' },
    async setup() {
      events.push('acquired');
      return {
        app: { request: async () => new Response('fixture') },
        reset() {
          events.push('reset');
        },
        async teardown() {
          await Promise.resolve();
          events.push('released');
        },
      };
    },
  };
  describe('suite using the fixture', () => {
    const context = setupConformance(descriptor);
    it('keeps its resource alive for the test', async () => {
      expect(await (await context().app.request('/')).text()).toBe('fixture');
      expect(events).toEqual(['acquired', 'reset']);
    });
  });
  // Outer suite cleanup happens after inner suite cleanup, including async teardown.
  afterAll(() => {
    expect(events).toEqual(['acquired', 'reset', 'released']);
  });
});

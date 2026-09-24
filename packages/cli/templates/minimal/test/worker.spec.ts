import { env } from 'cloudflare:workers';
import { createTestingWorker } from '@velajs/cloudflare/testing';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AppService } from '../src/app.service.js';

// Runs inside workerd: createTestingWorker builds AppModule as src/worker.ts
// does and sends requests through the Worker's fetch handler.
describe('AppModule', () => {
  it('answers GET / with the injected service message', async () => {
    const worker = await createTestingWorker(AppModule, { env });
    try {
      const response = await worker.fetch('/');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ message: 'Hello from Vela!' });
    } finally {
      await worker.close();
    }
  });

  it('injects a replacement service', async () => {
    const worker = await createTestingWorker(AppModule, {
      env,
      overrides: (module) =>
        module.overrideProvider(AppService).useValue({ getHello: () => 'Hello from a test!' }),
    });
    try {
      const response = await worker.fetch('/');
      expect(await response.json()).toEqual({ message: 'Hello from a test!' });
    } finally {
      await worker.close();
    }
  });
});

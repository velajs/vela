import type { VelaApplication } from '@velajs/vela';
import type { LoadedVelaConfig } from './config.js';

/**
 * Own one app for the whole command, including output and long-lived
 * transports, then the module runner that loaded its config: files the config
 * imports while the app runs load through that runner, so it closes last,
 * even when `createApp()` or the work throws.
 */
export async function withApp<Result>(
  loaded: Pick<LoadedVelaConfig, 'config' | 'dispose'>,
  work: (app: VelaApplication) => Result | Promise<Result>,
  warn: (message: string) => void,
): Promise<Result> {
  const report = (error: unknown): void => {
    try {
      warn(`Warning: teardown failed: ${String(error)}`);
    } catch {
      // A failed output stream must not replace the command's result/error.
    }
  };
  try {
    const app = await loaded.config.createApp();
    try {
      return await work(app);
    } finally {
      try {
        // Older 1.x apps may not implement full application disposal.
        if (typeof app.dispose === 'function') await app.dispose();
        else await app.getContainer().dispose();
      } catch (error) {
        report(error);
        // A throwing shutdown hook in older Vela versions can skip the container.
        // Disposal is idempotent; release constructed resources even in that case.
        try {
          await app.getContainer().dispose();
        } catch (cleanupError) {
          report(cleanupError);
        }
      }
    }
  } finally {
    try {
      await loaded.dispose();
    } catch (error) {
      report(error);
    }
  }
}

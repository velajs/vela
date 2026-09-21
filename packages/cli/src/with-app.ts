import type { VelaApplication } from '@velajs/vela';
import type { VelaConfig } from './config.js';

/** Own one app for the whole command, including output and long-lived transports. */
export async function withApp<Result>(
  config: VelaConfig,
  work: (app: VelaApplication) => Result | Promise<Result>,
  warn: (message: string) => void,
): Promise<Result> {
  const app = await config.createApp();
  const report = (error: unknown): void => {
    try {
      warn(`Warning: teardown failed: ${String(error)}`);
    } catch {
      // A failed output stream must not replace the command's result/error.
    }
  };
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
}

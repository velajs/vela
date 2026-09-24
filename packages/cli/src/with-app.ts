import { Console } from 'node:console';
import type { Writable } from 'node:stream';
import type { VelaApplication } from '@velajs/vela';
import type { LoadedVelaConfig } from './config.js';

/** The console methods that print; `Logger`'s default writer uses them too. */
const CONSOLE_METHODS = [
  'log',
  'info',
  'debug',
  'warn',
  'error',
  'trace',
  'dir',
  'dirxml',
  'table',
  'group',
  'groupCollapsed',
  'groupEnd',
  'count',
  'countReset',
  'time',
  'timeLog',
  'timeEnd',
  'assert',
] as const;

/**
 * Send everything the global console prints to `logs` until the returned
 * function restores it. Stdout stays the command's own: a `--json` document
 * or the MCP stdio channel.
 */
function redirectConsole(logs: Writable): () => void {
  const sink = new Console({ stdout: logs, stderr: logs });
  const saved = CONSOLE_METHODS.map(
    (name) => [name, Object.getOwnPropertyDescriptor(console, name)] as const,
  );
  for (const name of CONSOLE_METHODS) {
    Object.defineProperty(console, name, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: Reflect.get(sink, name),
    });
  }
  return () => {
    for (const [name, descriptor] of saved) {
      if (descriptor === undefined) Reflect.deleteProperty(console, name);
      else Object.defineProperty(console, name, descriptor);
    }
  };
}

/**
 * Own one app for the whole command: load it with `load` (`loadConfig()`,
 * which imports the config or Worker entry), build it, run `work` with it and
 * the loaded config, then dispose it and close the module runner that loaded
 * it: files the config imports while the app runs load through that runner,
 * so it closes last, even when `createApp()` or the work throws. From the
 * first import on, the application's console output (module-scope code and
 * `Logger` lines included) goes to `logs` (stderr).
 */
export async function withApp<Loaded extends Pick<LoadedVelaConfig, 'config' | 'dispose'>, Result>(
  load: () => Promise<Loaded>,
  work: (app: VelaApplication, loaded: Loaded) => Result | Promise<Result>,
  warn: (message: string) => void,
  logs: Writable = process.stderr,
): Promise<Result> {
  const report = (error: unknown): void => {
    try {
      warn(`Warning: teardown failed: ${String(error)}`);
    } catch {
      // A failed output stream must not replace the command's result/error.
    }
  };
  const restoreConsole = redirectConsole(logs);
  let loaded: Loaded;
  try {
    loaded = await load();
  } catch (error) {
    restoreConsole();
    throw error;
  }
  try {
    const app = await loaded.config.createApp();
    try {
      return await work(app, loaded);
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
    } finally {
      restoreConsole();
    }
  }
}

import { Command, Option } from 'clipanion';

/**
 * The optional peer that does the real work. It is Node-only and heavy, so it is
 * NOT a hard dependency of the CLI — it is lazily imported here and, when it
 * isn't installed, the command prints an install hint (mirroring how
 * `mcp.command` lazily loads its optional peer).
 */
const HOST_PACKAGE = '@velajs/studio-host';

/** The slice of `@velajs/studio-host`'s surface this command uses. */
interface StudioHostModule {
  startStudioServer(options: {
    workerOrigin: string;
    adminToken?: string;
    port?: number;
    adminPath?: string;
    cwd?: string;
  }): Promise<{ readonly url: string; readonly port: number; close(): Promise<void> }>;
}

/** True for a failed dynamic `import()` of a missing module (ESM or CJS code). */
function isModuleNotFound(error: unknown, specifier: string): boolean {
  const code = (error as { code?: string }).code;
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
    return true;
  }
  // Some resolvers surface only a message; match the specifier defensively.
  const message = error instanceof Error ? error.message : '';
  return message.includes(specifier);
}

/**
 * `vela studio` — start the loopback dev host that serves Vela Studio and proxies
 * the admin API to a running app.
 *
 * App-origin resolution (v1): the target app is taken from `--url <origin>`,
 * which is REQUIRED. The host proxies `{--path}/*` to that origin, injecting the
 * admin token as `Authorization: Bearer` server-side (the browser never holds
 * it). Booting the app in-process from `vela.config` (via `loadConfig`) is a
 * planned follow-up; requiring `--url` keeps v1 simple and adapter-agnostic.
 */
export class StudioCommand extends Command {
  static override paths = [['studio']];
  static override usage = Command.Usage({
    category: 'Studio',
    description: 'Serve Vela Studio locally and proxy the admin API to a running app.',
    details:
      'Starts a loopback dev host (from the optional @velajs/studio-host peer) that serves the ' +
      'prebuilt Studio SPA and proxies {--path}/* to the app at --url, injecting the admin token ' +
      'as a Bearer server-side so the browser never receives it. The token comes from --token or ' +
      'the VELA_STUDIO_TOKEN environment variable. Runs until interrupted (Ctrl+C).',
    examples: [
      ['Serve against a local worker', 'vela studio --url http://127.0.0.1:8787'],
      [
        'With an explicit token + port',
        'vela studio --url http://127.0.0.1:8787 --token $TOKEN --port 4000',
      ],
    ],
  });

  url = Option.String('--url', {
    description: 'Origin of the running app to proxy the admin API to (required).',
  });
  token = Option.String('--token', {
    description: 'Admin bearer token (falls back to VELA_STUDIO_TOKEN). Never sent to the browser.',
  });
  port = Option.String('--port', {
    description: 'Loopback port to bind (default: an ephemeral port).',
  });
  adminPath = Option.String('--path', {
    description: 'Server admin-mount prefix to proxy (default: /_vela/admin).',
  });

  async execute(): Promise<number> {
    const workerOrigin = this.url;
    if (workerOrigin === undefined || workerOrigin === '') {
      this.context.stderr.write(
        'vela studio: --url <origin> is required — the running app to proxy the admin API to.\n' +
          '  Example: vela studio --url http://127.0.0.1:8787\n',
      );
      return 1;
    }
    if (!URL.canParse(workerOrigin)) {
      this.context.stderr.write(`vela studio: --url is not a valid origin: ${workerOrigin}\n`);
      return 1;
    }

    let port: number | undefined;
    if (this.port !== undefined) {
      port = Number.parseInt(this.port, 10);
      if (Number.isNaN(port) || port < 0 || port > 65_535) {
        this.context.stderr.write(
          `vela studio: --port must be a number 0-65535, got: ${this.port}\n`,
        );
        return 1;
      }
    }

    const adminToken = this.token ?? process.env.VELA_STUDIO_TOKEN;

    let host: StudioHostModule;
    try {
      host = (await import(HOST_PACKAGE)) as StudioHostModule;
    } catch (error) {
      if (isModuleNotFound(error, HOST_PACKAGE)) {
        this.context.stderr.write(
          `vela studio needs the optional "${HOST_PACKAGE}" package, which isn't installed.\n` +
            `  Install it: pnpm add -D ${HOST_PACKAGE}\n` +
            `  (it also needs the prebuilt UI: pnpm add -D @velajs/studio-ui)\n`,
        );
        return 1;
      }
      throw error;
    }

    const server = await host.startStudioServer({
      workerOrigin,
      adminToken,
      port,
      adminPath: this.adminPath,
      cwd: process.cwd(),
    });

    this.context.stdout.write(
      `\n  Vela Studio   ${server.url}\n` +
        `  Proxying      ${workerOrigin}${this.adminPath ?? '/_vela/admin'}/*\n` +
        `  Admin token   ${adminToken !== undefined ? 'set (injected server-side)' : 'none (app requires none)'}\n\n` +
        '  Press Ctrl+C to stop.\n',
    );

    // Run until interrupted. The listener is removed on trigger so a second
    // Ctrl+C during shutdown falls through to Node's default (force-exit).
    await new Promise<void>((resolvePromise) => {
      const onSignal = (): void => {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        resolvePromise();
      };
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
    });

    await server.close();
    this.context.stdout.write('\nVela Studio stopped.\n');
    return 0;
  }
}

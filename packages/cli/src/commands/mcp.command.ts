import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpenApiDocument } from '@velajs/vela';
import type { Type, VelaApplication } from '@velajs/vela';
import { Command, Option } from 'clipanion';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import {
  collectEntrypoints,
  collectModules,
  collectRoutes,
  renderModuleTree,
} from '../introspect.js';

const OPENAPI_URI = 'vela://openapi';

/** A single JSON text block — the shape every tool/resource result uses. */
function jsonText(data: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/** An MCP tool error result (JSON-RPC stays 2.0; the failure is in-band). */
function toolError(message: string): { isError: true; content: { type: 'text'; text: string }[] } {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Name + version for the MCP server handshake, read from the CLI's own package.json. */
async function readCliIdentity(): Promise<{ name: string; version: string }> {
  const here = dirname(fileURLToPath(import.meta.url));
  // tsdown bundles this module into dist/index.js; source-mode tests load it
  // from src/commands/mcp.command.ts. Support both locations without relying
  // on a fixed output depth.
  for (const pkgPath of [
    join(here, '..', 'package.json'),
    join(here, '..', '..', 'package.json'),
  ]) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as {
        name?: string;
        version?: string;
      };
      return { name: pkg.name ?? '@velajs/cli', version: pkg.version ?? '0.0.0' };
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
    }
  }
  return { name: '@velajs/cli', version: '0.0.0' };
}

/**
 * String-label lookup for a DI token across the module graph. Reads only the
 * serializable descriptions (`collectModules`) — never resolves the token or
 * constructs anything. Reports which modules provide/export it and their scope
 * flags, plus whether the string names a module itself.
 */
function describeToken(app: VelaApplication, token: string): unknown {
  const modules = collectModules(app);
  const providedBy = modules
    .filter((m) => m.providers.includes(token))
    .map((m) => ({
      moduleId: m.moduleId,
      isGlobal: m.isGlobal,
      lazy: m.lazy,
      exported: m.exports.includes(token),
    }));
  const matchesModule = modules.find((m) => m.moduleId === token);
  return {
    token,
    found: providedBy.length > 0 || matchesModule !== undefined,
    providedBy,
    module: matchesModule
      ? {
          moduleId: matchesModule.moduleId,
          isGlobal: matchesModule.isGlobal,
          lazy: matchesModule.lazy,
        }
      : null,
  };
}

/**
 * `vela mcp serve` — an MCP stdio server exposing the same READ-ONLY
 * introspection as the `route`/`module`/`entrypoint`/`openapi` commands, so an
 * AI agent can query a Vela app's shape over the Model Context Protocol.
 *
 * Deliberately does NOT extend `AppCommand`: that base disposes the app in its
 * `finally` the moment `run()` returns, but an MCP server must stay alive until
 * the transport closes. stdout is reserved for JSON-RPC framing; every human
 * message goes to stderr.
 */
export class McpServeCommand extends Command {
  static override paths = [['mcp', 'serve']];
  static override usage = Command.Usage({
    category: 'Introspection',
    description: 'Serve Vela introspection as MCP tools over stdio (for AI agents).',
    details:
      'Builds the app from vela.config and runs a Model Context Protocol stdio server. Exposes ' +
      'read-only tools (route_list, module_graph, entrypoint_list, openapi_dump, token_describe) ' +
      'and — when the config declares a rootModule — a `vela://openapi` resource. stdout carries ' +
      'only JSON-RPC; all logging goes to stderr. The server runs until the client disconnects.',
    examples: [
      ['Serve over stdio', 'vela mcp serve'],
      ['Use a specific config', 'vela mcp serve --config ./config/vela.config.js'],
    ],
  });

  config = Option.String('--config', { description: 'Path to the vela config file.' });

  async execute(): Promise<number> {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');

    const log = (message: string): void => {
      this.context.stderr.write(`${message}\n`);
    };

    const velaConfig = await loadConfig(process.cwd(), this.config);
    const app = await velaConfig.createApp();
    const rootModule: Type | undefined = velaConfig.rootModule;

    try {
      const identity = await readCliIdentity();
      const server = new McpServer(identity);

      server.registerTool(
        'route_list',
        {
          description:
            "The app's HTTP route table: framework-composed controller routes (method, full " +
            'path, Controller#handler) plus everything else mounted on the router, labeled ' +
            '(mounted). Empty when the app builds no HTTP routes.',
          inputSchema: {},
        },
        () => jsonText(collectRoutes(app) ?? []),
      );

      server.registerTool(
        'module_graph',
        {
          description:
            'The loaded module graph as serializable descriptions (providers, exports, imports, ' +
            'global/lazy flags). Pass tree=true to also get the rendered import tree lines.',
          inputSchema: { tree: z.boolean().optional() },
        },
        ({ tree }) => {
          const modules = collectModules(app);
          return jsonText(tree ? { modules, tree: renderModuleTree(modules) } : modules);
        },
      );

      server.registerTool(
        'entrypoint_list',
        {
          description:
            'Every declared entrypoint kind (websocket, queue, cron, …) with its entries and ' +
            'metadata — including kinds with zero entries. Lazy modules stay unmaterialized.',
          inputSchema: {},
        },
        () => jsonText(collectEntrypoints(app)),
      );

      server.registerTool(
        'openapi_dump',
        {
          description:
            'The OpenAPI 3.1 document for the app. Requires a rootModule in vela.config. ' +
            'globalPrefix/title/apiVersion override the defaults (the app global prefix and ' +
            'the module-derived info).',
          inputSchema: {
            globalPrefix: z.string().optional(),
            title: z.string().optional(),
            apiVersion: z.string().optional(),
          },
        },
        ({ globalPrefix, title, apiVersion }) => {
          if (!rootModule) {
            return toolError(
              'openapi_dump needs the root module. Add `rootModule: AppModule` to your vela.config.',
            );
          }
          const info: Record<string, string> = {};
          if (title) info.title = title;
          if (apiVersion) info.version = apiVersion;
          const document = createOpenApiDocument(rootModule, {
            globalPrefix: globalPrefix ?? app.getGlobalPrefix(),
            ...(Object.keys(info).length > 0 ? { info } : {}),
          });
          return jsonText(document);
        },
      );

      server.registerTool(
        'token_describe',
        {
          description:
            'Look a DI token STRING LABEL up across the module graph: which modules provide/export ' +
            'it and their scope flags, plus whether the string names a module. Read-only string ' +
            'match — does not resolve or construct the token.',
          inputSchema: { token: z.string() },
        },
        ({ token }) => jsonText(describeToken(app, token)),
      );

      if (rootModule) {
        server.registerResource(
          'openapi',
          OPENAPI_URI,
          { description: 'The OpenAPI 3.1 document for the app.', mimeType: 'application/json' },
          () => ({
            contents: [
              {
                uri: OPENAPI_URI,
                mimeType: 'application/json',
                text: JSON.stringify(
                  createOpenApiDocument(rootModule, { globalPrefix: app.getGlobalPrefix() }),
                  null,
                  2,
                ),
              },
            ],
          }),
        );
      }

      const transport = new StdioServerTransport();
      const closed = new Promise<void>((resolvePromise) => {
        transport.onclose = resolvePromise;
      });
      await server.connect(transport);
      log(
        `vela mcp serve — ready (5 tools${rootModule ? ' + vela://openapi resource' : ''}). ` +
          'Awaiting client on stdio; stdout is JSON-RPC only.',
      );

      // Keep the process alive until the client disconnects; only then dispose.
      await closed;
      return 0;
    } finally {
      const dispose = (app as { dispose?: () => Promise<void> }).dispose;
      if (typeof dispose === 'function') {
        try {
          await dispose.call(app);
        } catch (error) {
          this.context.stderr.write(`Warning: teardown failed: ${String(error)}\n`);
        }
      }
    }
  }
}

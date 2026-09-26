import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from '@swc/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Integration test for `vela mcp serve`: spawn the built CLI against a fixture
 * `vela.config`, drive a real stdio JSON-RPC handshake, and assert stdout
 * carries ONLY JSON-RPC frames (all human-readable logging must go to stderr).
 */

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliEntry = join(rootDir, 'dist', 'index.js');

/** Fixture config source — compiled to `.mjs` and loaded by the spawned CLI. */
const FIXTURE_SOURCE = `
import { Controller, Get, Head, Injectable, InjectionToken, defineProvider, Module, VelaFactory } from '@velajs/vela';
import { Process, Processor, QueueModule } from '@velajs/vela/queue';

const SHARED = new InjectionToken('cli-test:shared');

@Controller({ path: 'users', version: 1 })
class UsersController {
  @Get(':id') getOne() { return {}; }
  @Head('ping') ping() { return {}; }
}

@Injectable() class LazyThing {}

@Processor('email')
class EmailProcessor { @Process('welcome') welcome() {} }

@Module({ lazy: true, providers: [LazyThing] }) class LazyMod {}
@Module({ providers: [defineProvider(SHARED, { useValue: 'x' })], exports: [SHARED] }) class SharedMod {}

@Module({
  imports: [SharedMod, LazyMod, QueueModule.forRoot(), QueueModule.forFeature([{ name: 'email' }])],
  controllers: [UsersController],
  providers: [EmailProcessor],
})
class App {}

export default {
  rootModule: App,
  async createApp() { return VelaFactory.create(App, { globalPrefix: '/api' }); },
};
`;

let fixturePath: string;
let tmpDir: string;

beforeAll(() => {
  // Compile the fixture (legacy decorators + metadata, matching vitest.config)
  // and write it inside the worktree so `@velajs/vela` resolves from node_modules.
  const { code } = transformSync(FIXTURE_SOURCE, {
    filename: 'vela.config.fixture.ts',
    module: { type: 'es6' },
    isModule: true,
    jsc: {
      target: 'es2022',
      parser: { syntax: 'typescript', decorators: true },
      transform: { legacyDecorator: true, decoratorMetadata: true },
      keepClassNames: true,
    },
  });
  tmpDir = mkdtempSync(join(rootDir, 'mcp-fixture-'));
  fixturePath = join(tmpDir, 'vela.config.fixture.mjs');
  writeFileSync(fixturePath, code, 'utf8');
}, 120_000);

afterAll(() => {
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

/** Minimal newline-delimited JSON-RPC client over a child process' stdio. */
class StdioRpc {
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, (msg: Record<string, unknown>) => void>();
  /** Every non-empty line the server wrote to stdout, verbatim. */
  readonly stdoutLines: string[] = [];

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line.length === 0) continue;
        this.stdoutLines.push(line);
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (typeof msg.id === 'number') this.pending.get(msg.id)?.(msg);
      }
    });
  }

  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const frame = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(
        () => rejectPromise(new Error(`Timed out waiting for ${method}`)),
        15_000,
      );
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolvePromise(msg);
      });
      this.child.stdin.write(`${JSON.stringify(frame)}\n`);
    });
  }

  notify(method: string): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }
}

describe('vela mcp serve', () => {
  it('completes a stdio JSON-RPC handshake and keeps stdout pure', async () => {
    let stderr = '';
    let exitCode: number | null = null;
    const child = spawn('node', [cliEntry, 'mcp', 'serve', '--config', fixturePath], {
      cwd: rootDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => {
      stderr += c;
    });
    const exited = new Promise<void>((res) => {
      child.on('exit', (code) => {
        exitCode = code;
        res();
      });
    });

    const rpc = new StdioRpc(child);

    // 1) initialize
    const init = await rpc.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'mcp-test-harness', version: '0.0.0' },
    });
    const initResult = init.result as { serverInfo?: { name?: string; version?: string } };
    expect(init.error).toBeUndefined();
    expect(initResult.serverInfo?.name).toBe('@velajs/cli');
    rpc.notify('notifications/initialized');

    // 2) tools/list
    const list = await rpc.request('tools/list', {});
    const tools = (list.result as { tools: { name: string }[] }).tools;
    const toolNames = tools.map((t) => t.name).sort();
    expect(toolNames).toEqual(
      ['entrypoint_list', 'module_graph', 'openapi_dump', 'route_list', 'token_describe'].sort(),
    );

    // 3) tools/call route_list
    const call = await rpc.request('tools/call', { name: 'route_list', arguments: {} });
    const callResult = call.result as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };
    expect(callResult.isError).toBeFalsy();
    expect(callResult.content[0].type).toBe('text');
    const routes = JSON.parse(callResult.content[0].text) as { path: string; handler: string }[];
    expect(
      routes.some((r) => r.path === '/api/v1/users/:id' && r.handler === 'UsersController#getOne'),
    ).toBe(true);

    // Close the transport → server disconnects → process exits cleanly.
    child.stdin.end();
    await exited;

    // stdout MUST carry only JSON-RPC frames — every line parses and is 2.0.
    expect(rpc.stdoutLines.length).toBeGreaterThan(0);
    for (const line of rpc.stdoutLines) {
      const parsed = JSON.parse(line) as { jsonrpc?: string };
      expect(parsed.jsonrpc).toBe('2.0');
    }
    // Human-readable startup logging goes to stderr, never stdout.
    expect(stderr).toContain('vela mcp serve');
    expect(exitCode).toBe(0);
  }, 60_000);
});

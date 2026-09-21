import { describe, expect, it, vi } from 'vitest';

import { defineAgent } from '../index';
import { mcpTools } from '../mcp';
import type { McpClientLike } from '../mcp';
import {
  createAgentHarness,
  finalTurn,
  memoryThreadStore,
  scriptedGenerate,
  toolCallTurn,
} from '../testing';
import { fakeToolContext, resolveTestRunIdentity, testThreadScope, toolCall } from './support';

/** A structural MCP client double — no `@modelcontextprotocol/sdk` involved. */
const fakeClient: McpClientLike = {
  listTools: async () => ({
    tools: [
      {
        name: 'search',
        description: 'Search the knowledge base',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      },
      { name: 'calc', description: 'Evaluate an expression' },
    ],
  }),
  callTool: async ({ name }) => {
    if (name === 'search') {
      return { structuredContent: { hits: 2 } };
    }

    if (name === 'calc') {
      return { content: [{ type: 'text', text: '42' }] };
    }

    return { content: [{ type: 'text', text: 'kaboom' }], isError: true };
  },
  close: async () => undefined,
};

describe('mcpTools', () => {
  it('adapts an injected client into branded tools, honouring prefix', async () => {
    const tools = await mcpTools({ client: fakeClient, prefix: 'mcp_', only: ['search', 'calc'] });

    expect(Object.keys(tools).sort()).toEqual(['mcp_calc', 'mcp_search']);
    expect(tools.mcp_search?.isVelaAgentTool).toBe(true);
    expect(tools.mcp_search?.description).toBe('Search the knowledge base');
  });

  it('honours the only filter (matched on the original name)', async () => {
    const tools = await mcpTools({ client: fakeClient, only: ['search'] });

    expect(Object.keys(tools)).toEqual(['search']);
  });

  it('returns structuredContent as-is and joined text otherwise', async () => {
    const tools = await mcpTools({
      client: fakeClient,
      only: ['search', 'calc'],
      readOnlyTools: ['search', 'calc'],
    });

    const searchOut = await tools.search?.execute({ q: 'x' }, fakeToolContext({ q: 'x' }));
    expect(searchOut).toEqual({ hits: 2 });

    const calcOut = await tools.calc?.execute({}, fakeToolContext({}));
    expect(calcOut).toBe('42');
  });

  it('returns an isError result as an error STRING, never thrown', async () => {
    const errorClient: McpClientLike = {
      listTools: async () => ({ tools: [{ name: 'boom' }] }),
      callTool: async () => ({ content: [{ type: 'text', text: 'kaboom' }], isError: true }),
      close: async () => undefined,
    };
    const tools = await mcpTools({ client: errorClient, only: ['boom'], readOnlyTools: ['boom'] });

    const output = await tools.boom?.execute({}, fakeToolContext({}));
    expect(typeof output).toBe('string');
    expect(output).toContain('kaboom');
  });

  it('rejects the stdio (command) transport', async () => {
    await expect(mcpTools({ command: 'node server.js', only: ['search'] })).rejects.toThrow(
      /stdio/,
    );
  });

  it('rejects insecure, private, and non-allowlisted remote URLs before connecting', async () => {
    await expect(
      mcpTools({
        url: 'http://tools.example.com',
        allowedHosts: ['tools.example.com'],
        only: ['search'],
      }),
    ).rejects.toThrow(/must use HTTPS/);
    await expect(
      mcpTools({ url: 'https://127.0.0.1', allowedHosts: ['127.0.0.1'], only: ['search'] }),
    ).rejects.toThrow(/private/);
    await expect(
      mcpTools({
        url: 'https://[::ffff:127.0.0.1]',
        allowedHosts: ['::ffff:7f00:1'],
        only: ['search'],
      }),
    ).rejects.toThrow(/private/);
    await expect(
      mcpTools({
        url: 'https://tools.example.com',
        allowedHosts: ['other.example.com'],
        only: ['search'],
      }),
    ).rejects.toThrow(/allowedHosts/);
  });

  it('runs an adapted tool inside its tool:<name>:<id> durable step', async () => {
    const store = memoryThreadStore();
    const tools = await mcpTools({
      client: fakeClient,
      only: ['search', 'calc'],
      readOnlyTools: ['search', 'calc'],
    });
    const agent = defineAgent({
      model: 'test-model',
      store,
      resolveRunIdentity: resolveTestRunIdentity,
      tools,
    });
    const agentHarness = createAgentHarness();

    const result = await agentHarness.runAgent(agent, 'mcpAgent', {
      params: { threadKey: 't-mcp', input: 'find it', runKey: 'run-mcp' },
      generate: scriptedGenerate([
        toolCallTurn([toolCall('search', 'call-0', { q: 'x' })]),
        finalTurn('done'),
      ]),
    });

    expect(result.status).toBe('complete');
    expect(agentHarness.harness.invocations('tool:search:call-0')).toBe(1);

    const rows = await store.listMessages(testThreadScope('t-mcp', 'agent-mcp-agent'));
    const toolResult = rows.find((row) => row.role === 'tool' && row.toolCallId === 'call-0');
    expect(toolResult?.content).toBe(JSON.stringify({ hits: 2 }));
  });

  it('requires an explicit tool allowlist and approval for tools not marked read-only', async () => {
    await expect(mcpTools({ client: fakeClient, only: [] })).rejects.toThrow(/non-empty allowlist/);

    const tools = await mcpTools({ client: fakeClient, only: ['search'] });
    expect(tools.search?.needsApproval).toBe(true);
  });

  it('forwards the durable step id as an MCP idempotency key', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const client: McpClientLike = {
      listTools: async () => ({ tools: [{ name: 'write' }] }),
      callTool: async (params) => {
        calls.push(params);
        return { structuredContent: { ok: true } };
      },
      close: async () => undefined,
    };
    const tools = await mcpTools({ client, only: ['write'], readOnlyTools: ['write'] });
    await tools.write?.execute({ value: 1 }, fakeToolContext({ value: 1 }));

    expect(calls[0]?._meta).toEqual({ 'velajs.dev/idempotency-key': 'tool:test:0' });
  });

  it('caps result size and operation duration', async () => {
    const largeClient: McpClientLike = {
      listTools: async () => ({ tools: [{ name: 'large' }] }),
      callTool: async () => ({ content: [{ type: 'text', text: 'x'.repeat(32) }] }),
      close: async () => undefined,
    };
    const tools = await mcpTools({
      client: largeClient,
      only: ['large'],
      readOnlyTools: ['large'],
      maxResultBytes: 16,
    });
    await expect(tools.large?.execute({}, fakeToolContext({}))).rejects.toMatchObject({
      code: 'AGENT_MCP_RESULT_TOO_LARGE',
    });

    const close = vi.fn(async () => undefined);
    let requestSignal: AbortSignal | undefined;
    const slowClient: McpClientLike = {
      listTools: async () => ({ tools: [{ name: 'slow' }] }),
      callTool: async (_params, options) => {
        requestSignal = options?.signal;
        return new Promise(() => undefined);
      },
      close,
    };
    const slowTools = await mcpTools({
      client: slowClient,
      only: ['slow'],
      readOnlyTools: ['slow'],
      timeoutMs: 5,
    });
    await expect(slowTools.slow?.execute({}, fakeToolContext({}))).rejects.toMatchObject({
      code: 'AGENT_MCP_TIMEOUT',
    });
    expect(requestSignal?.aborted).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });
});

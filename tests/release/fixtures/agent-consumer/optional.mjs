import assert from 'node:assert/strict';
import { rename } from 'node:fs/promises';

// Fresh process: root, testing, and injected MCP imports must not load these peers.
for (const name of ['ai', 'mail']) {
  await rename(`node_modules/@velajs/${name}`, `node_modules/@velajs/${name}-optional-test`);
}
assert.throws(() => import.meta.resolve('@modelcontextprotocol/sdk'), /Cannot find/);
const root = await import('@velajs/agent');
const testing = await import('@velajs/agent/testing');
const mcp = await import('@velajs/agent/mcp');
assert.equal(typeof root.compileAgent, 'function');
assert.equal(typeof testing.memoryThreadStore, 'function');
assert.equal(typeof mcp.mcpTools, 'function');

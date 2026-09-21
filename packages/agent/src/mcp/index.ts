/**
 * `@velajs/agent/mcp` — adapt tools from an MCP server into agent tools.
 *
 * `@modelcontextprotocol/sdk` is an OPTIONAL peer, reached only through a
 * DYNAMIC import in the `url` branch (behind a non-analyzable specifier, so this
 * subpath type-checks and builds even when the SDK is absent). The core stays
 * light: injecting a structural {@link McpClientLike} never touches the SDK. Each
 * adapted tool runs inside the loop's `tool:<name>:<id>` durable step like any
 * other; an MCP `isError` result is returned as an error STRING (not thrown), so
 * the next turn can recover.
 */
import { canonicalJson } from '../validation';
import { jsonSchema } from 'ai';

import { AgentError } from '../errors';
import { defineAgentTool } from '../tools';
import type { AgentToolDefinition } from '../types';

/** One tool descriptor as reported by `listTools`. */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  /** A JSON Schema object for the tool's arguments. */
  inputSchema?: unknown;
}

/** The result shape of an MCP `callTool`. */
export interface McpCallToolResult {
  content?: ReadonlyArray<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
}

/** Cancellation and byte-budget contract required from injected MCP clients. */
export interface McpRequestOptions {
  signal: AbortSignal;
  timeout: number;
  maxTotalTimeout: number;
  maxResponseBytes: number;
}

/**
 * The structural slice of an MCP client this adapter uses. A real
 * `@modelcontextprotocol/sdk` `Client` satisfies it, and so does a plain test
 * double — declared locally so nothing here imports the SDK's types.
 */
export interface McpClientLike {
  listTools(params?: unknown, options?: McpRequestOptions): Promise<{ tools: McpToolDescriptor[] }>;
  callTool(
    params: {
      name: string;
      arguments?: unknown;
      _meta?: Record<string, unknown>;
    },
    options?: McpRequestOptions,
  ): Promise<McpCallToolResult>;
  connect?(transport: unknown): Promise<void>;
  /** Must cancel in-flight requests and release the transport. */
  close(): Promise<void>;
}

/** Options for {@link mcpTools}. Provide `client` (injected) or `url` (dynamic SDK). */
export interface McpToolsOptions {
  /** An already-built client — bypasses the SDK entirely. */
  client?: McpClientLike;
  /** MCP server URL — connected via the dynamically-imported SDK. */
  url?: string;
  /** Remote transport when using `url` (default `'http'`). */
  transport?: 'http' | 'sse';
  /** Required allowlist of remote tool names (matched on the ORIGINAL name). */
  only: ReadonlyArray<string>;
  /** Application-verified read-only tools. Every other tool requires human approval. */
  readOnlyTools?: ReadonlyArray<string>;
  /** Required exact hostname allowlist when `url` is used. */
  allowedHosts?: ReadonlyArray<string>;
  /**
   * Required for URL mode. Must enforce deployment-level DNS/egress policy;
   * Vela additionally rejects redirects, unexpected hosts, and oversized bodies.
   */
  fetch?: typeof fetch;
  /** Per-operation timeout. Defaults to and may not exceed 30 seconds. */
  timeoutMs?: number;
  /** Maximum returned tool payload. Defaults to and may not exceed 1 MiB. */
  maxResultBytes?: number;
  /** Prefix prepended to each adapted tool's map key. */
  prefix?: string;
  /** Client name reported to the server (default `@velajs/agent`). */
  name?: string;
  /** Client version reported to the server (default `1.0.0`). */
  version?: string;
  /** stdio command — REJECTED: no stdio transport in an edge runtime. */
  command?: string;
}

const MAX_TIMEOUT_MS = 30_000;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_TOOL_COUNT = 256;
const TOOL_NAME_PATTERN = /^[A-Za-z][\w-]*$/;

const resultSize = (value: unknown): number => {
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    return new TextEncoder().encode(serialized ?? 'null').byteLength;
  } catch (cause) {
    throw new AgentError('AGENT_MCP_RESULT_TOO_LARGE', 'MCP returned a non-serialisable result', {
      status: 502,
      cause,
    });
  }
};

const assertResultSize = (value: unknown, maxResultBytes: number): unknown => {
  if (resultSize(value) > maxResultBytes) {
    throw new AgentError(
      'AGENT_MCP_RESULT_TOO_LARGE',
      `MCP result exceeds the ${maxResultBytes}-byte limit`,
      { status: 502 },
    );
  }
  return value;
};

/** Reduce an MCP call result to what a tool `execute` returns. */
const reduceMcpResult = (result: McpCallToolResult, maxResultBytes: number): unknown => {
  if (
    !result ||
    typeof result !== 'object' ||
    (result.content !== undefined &&
      (!Array.isArray(result.content) ||
        result.content.some(
          (part) => !part || typeof part !== 'object' || typeof part.type !== 'string',
        ))) ||
    (result.isError !== undefined && typeof result.isError !== 'boolean')
  ) {
    throw new AgentError('AGENT_MCP_INVALID_CONFIGURATION', 'MCP returned a malformed result', {
      status: 502,
    });
  }
  assertResultSize(result, maxResultBytes);
  if (result.structuredContent !== undefined && result.isError !== true) {
    return assertResultSize(result.structuredContent, maxResultBytes);
  }

  const text = (result.content ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n');

  // An error result comes back as a STRING (not thrown) so the next turn recovers.
  if (result.isError === true) {
    return assertResultSize(
      `MCP tool error: ${text.length > 0 ? text : 'unknown error'}`,
      maxResultBytes,
    );
  }

  return assertResultSize(text, maxResultBytes);
};

const withTimeout = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  onTimeout: () => void | Promise<void>,
): Promise<T> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new AgentError('AGENT_MCP_TIMEOUT', `MCP operation exceeded ${timeoutMs}ms`, {
        status: 504,
      });
      reject(error);
      controller.abort(error);
      void Promise.resolve(onTimeout()).catch(() => undefined);
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const requestOptions = (
  signal: AbortSignal,
  timeoutMs: number,
  maxResponseBytes: number,
): McpRequestOptions => ({
  signal,
  timeout: timeoutMs,
  maxTotalTimeout: timeoutMs,
  maxResponseBytes,
});

/** Coerce an untrusted descriptor schema to a jsonSchema input, defaulting to an open object. */
const toInputSchema = (schema: unknown): Parameters<typeof jsonSchema>[0] => {
  if (schema === undefined) return { type: 'object' };
  if (schema !== null && typeof schema === 'object' && !Array.isArray(schema)) {
    return schema as Parameters<typeof jsonSchema>[0];
  }

  throw new AgentError(
    'AGENT_MCP_INVALID_CONFIGURATION',
    'MCP tool inputSchema must be an object schema',
  );
};

/** Connect to an MCP server over http/sse via the dynamically-imported optional SDK. */
const connectClient = async (
  options: McpToolsOptions,
  timeoutMs: number,
  maxResultBytes: number,
): Promise<McpClientLike> => {
  if (options.url === undefined) {
    throw new AgentError(
      'AGENT_MCP_MISSING_CLIENT',
      'mcpTools needs an injected `client` or a `url` to connect to',
    );
  }
  const remoteUrl = validateRemoteUrl(options);
  if (options.fetch === undefined) {
    throw new AgentError(
      'AGENT_MCP_INVALID_CONFIGURATION',
      'URL mode requires an egress-policy fetch implementation that denies private DNS targets',
    );
  }

  // The specifiers are typed as `string` so the compiler does not resolve the
  // optional peer at build time; the modules are only needed at runtime here.
  const clientSpecifier: string = '@modelcontextprotocol/sdk/client/index.js';
  const transportSpecifier: string =
    options.transport === 'sse'
      ? '@modelcontextprotocol/sdk/client/sse.js'
      : '@modelcontextprotocol/sdk/client/streamableHttp.js';

  interface SdkClientLike {
    listTools(
      params?: unknown,
      options?: { signal?: AbortSignal; timeout?: number; maxTotalTimeout?: number },
    ): Promise<{ tools: McpToolDescriptor[] }>;
    callTool(
      params: { name: string; arguments?: unknown; _meta?: Record<string, unknown> },
      resultSchema?: unknown,
      options?: { signal?: AbortSignal; timeout?: number; maxTotalTimeout?: number },
    ): Promise<McpCallToolResult>;
    connect(
      transport: unknown,
      options?: { signal?: AbortSignal; timeout?: number; maxTotalTimeout?: number },
    ): Promise<void>;
    close(): Promise<void>;
  }

  let clientModule: { Client: new (info: { name: string; version: string }) => SdkClientLike };
  let transportModule: Record<
    string,
    new (url: URL, options?: { fetch?: typeof fetch }) => { close?: () => Promise<void> }
  >;

  try {
    clientModule = (await import(clientSpecifier)) as typeof clientModule;
    transportModule = (await import(transportSpecifier)) as typeof transportModule;
  } catch (cause) {
    throw new AgentError(
      'AGENT_MCP_MISSING_CLIENT',
      'the optional peer `@modelcontextprotocol/sdk` is not installed — add it, or inject a `client`',
      { cause },
    );
  }

  const TransportCtor =
    options.transport === 'sse'
      ? transportModule.SSEClientTransport
      : transportModule.StreamableHTTPClientTransport;

  if (TransportCtor === undefined) {
    throw new AgentError(
      'AGENT_MCP_MISSING_CLIENT',
      'the MCP SDK transport constructor was not found',
    );
  }

  const maxWireBytes = Math.min(MAX_RESULT_BYTES + 64 * 1024, maxResultBytes + 64 * 1024);
  const guardedFetch = createGuardedFetch(options, maxWireBytes);
  const transport = new TransportCtor(remoteUrl, { fetch: guardedFetch });
  const sdkClient = new clientModule.Client({
    name: options.name ?? '@velajs/agent',
    version: options.version ?? '1.0.0',
  });

  try {
    await withTimeout(
      (signal) =>
        sdkClient.connect(transport, {
          signal,
          timeout: timeoutMs,
          maxTotalTimeout: timeoutMs,
        }),
      timeoutMs,
      async () => {
        await transport.close?.().catch(() => undefined);
        await sdkClient.close().catch(() => undefined);
      },
    );
  } catch (error) {
    await sdkClient.close().catch(() => undefined);
    throw error;
  }

  return {
    listTools: (params, operation) =>
      sdkClient.listTools(
        params,
        operation === undefined
          ? undefined
          : {
              signal: operation.signal,
              timeout: operation.timeout,
              maxTotalTimeout: operation.maxTotalTimeout,
            },
      ),
    callTool: (params, operation) =>
      sdkClient.callTool(
        params,
        undefined,
        operation === undefined
          ? undefined
          : {
              signal: operation.signal,
              timeout: operation.timeout,
              maxTotalTimeout: operation.maxTotalTimeout,
            },
      ),
    close: () => sdkClient.close(),
  };
};

const validateRemoteUrl = (options: McpToolsOptions): URL => {
  let url: URL;
  try {
    url = new URL(options.url as string);
  } catch (cause) {
    throw new AgentError('AGENT_MCP_INVALID_CONFIGURATION', '`url` must be a valid HTTPS URL', {
      cause,
    });
  }

  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new AgentError(
      'AGENT_MCP_INVALID_CONFIGURATION',
      'MCP URLs must use HTTPS and must not contain credentials',
    );
  }

  assertAllowedRemoteUrl(url, options.allowedHosts);
  return url;
};

const assertAllowedRemoteUrl = (url: URL, configuredHosts: ReadonlyArray<string> | undefined) => {
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new AgentError(
      'AGENT_MCP_INVALID_CONFIGURATION',
      'MCP URLs must use HTTPS and must not contain credentials',
    );
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isLocalOrPrivateHost(hostname)) {
    throw new AgentError(
      'AGENT_MCP_INVALID_CONFIGURATION',
      `MCP host "${hostname}" is local, private, or link-local`,
    );
  }

  const allowedHosts = configuredHosts?.map((host) => host.toLowerCase());
  if (allowedHosts === undefined || allowedHosts.length === 0 || !allowedHosts.includes(hostname)) {
    throw new AgentError(
      'AGENT_MCP_INVALID_CONFIGURATION',
      `MCP host "${hostname}" is not in the explicit allowedHosts list`,
    );
  }
};

const createGuardedFetch = (options: McpToolsOptions, maxWireBytes: number): typeof fetch => {
  const upstream = options.fetch!;
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assertAllowedRemoteUrl(url, options.allowedHosts);
    const response = await upstream(input, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new AgentError(
        'AGENT_MCP_INVALID_CONFIGURATION',
        'MCP redirects are disabled; allowlist the final HTTPS endpoint explicitly',
        { status: 502 },
      );
    }
    return limitResponseBody(response, maxWireBytes);
  };
};

const limitResponseBody = (response: Response, maxBytes: number): Response => {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new AgentError(
      'AGENT_MCP_RESULT_TOO_LARGE',
      `MCP response exceeds the ${maxBytes}-byte wire limit`,
      { status: 502 },
    );
  }
  if (response.body === null) return response;

  const reader = response.body.getReader();
  let seen = 0;
  const bounded = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read();
      if (next.done) {
        controller.close();
        return;
      }
      seen += next.value.byteLength;
      if (seen > maxBytes) {
        await reader.cancel().catch(() => undefined);
        controller.error(
          new AgentError(
            'AGENT_MCP_RESULT_TOO_LARGE',
            `MCP response exceeds the ${maxBytes}-byte wire limit`,
            { status: 502 },
          ),
        );
        return;
      }
      controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(bounded, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

const isLocalOrPrivateHost = (hostname: string): boolean => {
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    return true;
  }

  const octets = hostname.split('.').map(Number);
  if (
    octets.length === 4 &&
    octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
  ) {
    const [a = 0, b = 0] = octets;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }

  if (!hostname.includes(':')) return false;
  const ipv6 = hostname.toLowerCase();
  return (
    ipv6 === '::' ||
    ipv6 === '::1' ||
    // Reject IPv4-mapped/compatible literals rather than letting alternate
    // spellings (for example ::ffff:127.0.0.1) bypass the IPv4 checks above.
    ipv6.startsWith('::ffff:') ||
    /^::(?:\d{1,3}\.){3}\d{1,3}$/.test(ipv6) ||
    ipv6.startsWith('fc') ||
    ipv6.startsWith('fd') ||
    /^fe[89ab]/.test(ipv6) ||
    ipv6.startsWith('ff')
  );
};

/**
 * Adapt an MCP server's tools into a map of {@link AgentToolDefinition}s, ready to
 * spread into an agent's `tools`. Provide an injected `client` (recommended, and
 * SDK-free) or a `url`. Honours `only` (filter) and `prefix` (map-key prefix).
 */
export const mcpTools = async (
  options: McpToolsOptions,
): Promise<Record<string, AgentToolDefinition>> => {
  if (options.command !== undefined) {
    throw new AgentError(
      'AGENT_MCP_UNSUPPORTED_TRANSPORT',
      'the stdio (`command`) MCP transport is not available in an edge runtime — inject a `client` or use an http/sse `url`',
    );
  }

  if (options.only.length === 0 || options.only.some((name) => !TOOL_NAME_PATTERN.test(name))) {
    throw new AgentError(
      'AGENT_MCP_INVALID_CONFIGURATION',
      '`only` must be a non-empty allowlist of identifier-shaped MCP tool names',
    );
  }

  const timeoutMs = options.timeoutMs ?? MAX_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new AgentError(
      'AGENT_MCP_INVALID_CONFIGURATION',
      `\`timeoutMs\` must be an integer between 1 and ${MAX_TIMEOUT_MS}`,
    );
  }

  const maxResultBytes = options.maxResultBytes ?? MAX_RESULT_BYTES;
  if (
    !Number.isSafeInteger(maxResultBytes) ||
    maxResultBytes < 1 ||
    maxResultBytes > MAX_RESULT_BYTES
  ) {
    throw new AgentError(
      'AGENT_MCP_INVALID_CONFIGURATION',
      `\`maxResultBytes\` must be an integer between 1 and ${MAX_RESULT_BYTES}`,
    );
  }

  const client = options.client ?? (await connectClient(options, timeoutMs, maxResultBytes));
  if (typeof client.close !== 'function') {
    throw new AgentError(
      'AGENT_MCP_INVALID_CONFIGURATION',
      'injected MCP clients must implement close() so timed-out requests can be cancelled',
    );
  }
  try {
    const listed = await withTimeout(
      (signal) =>
        client.listTools(
          undefined,
          requestOptions(signal, timeoutMs, MAX_RESULT_BYTES + 64 * 1024),
        ),
      timeoutMs,
      () => client.close(),
    );
    assertResultSize(listed, MAX_RESULT_BYTES);
    if (
      !listed ||
      !Array.isArray(listed.tools) ||
      listed.tools.length > MAX_TOOL_COUNT ||
      listed.tools.some(
        (descriptor) =>
          !descriptor ||
          typeof descriptor.name !== 'string' ||
          (descriptor.description !== undefined && typeof descriptor.description !== 'string'),
      )
    ) {
      throw new AgentError(
        'AGENT_MCP_INVALID_CONFIGURATION',
        `MCP may expose at most ${MAX_TOOL_COUNT} tools`,
        { status: 502 },
      );
    }
    const only = new Set(options.only);
    const readOnly = new Set(options.readOnlyTools ?? []);
    if ([...readOnly].some((name) => !only.has(name))) {
      throw new AgentError(
        'AGENT_MCP_INVALID_CONFIGURATION',
        '`readOnlyTools` must be a subset of the explicit `only` allowlist',
      );
    }
    const prefix = options.prefix ?? '';
    const tools: Record<string, AgentToolDefinition> = Object.create(null) as Record<
      string,
      AgentToolDefinition
    >;

    for (const descriptor of listed.tools) {
      if (!only.has(descriptor.name)) {
        continue;
      }

      canonicalJson(descriptor.inputSchema ?? { type: 'object' });
      const mappedName = `${prefix}${descriptor.name}`;
      if (!TOOL_NAME_PATTERN.test(mappedName) || Object.hasOwn(tools, mappedName)) {
        throw new AgentError(
          'AGENT_MCP_INVALID_CONFIGURATION',
          `MCP tool name "${mappedName}" is invalid or duplicated`,
          { status: 502 },
        );
      }

      tools[mappedName] = defineAgentTool({
        description: descriptor.description ?? `MCP tool "${descriptor.name}"`,
        inputSchema: jsonSchema(toInputSchema(descriptor.inputSchema)),
        needsApproval: !readOnly.has(descriptor.name),
        execute: async (input: unknown, ctx): Promise<unknown> =>
          reduceMcpResult(
            await withTimeout(
              (signal) =>
                client.callTool(
                  {
                    name: descriptor.name,
                    arguments: input,
                    _meta: { 'velajs.dev/idempotency-key': ctx.idempotencyKey },
                  },
                  requestOptions(signal, timeoutMs, maxResultBytes + 64 * 1024),
                ),
              timeoutMs,
              () => client.close(),
            ),
            maxResultBytes,
          ),
      });
    }

    const missing = [...only].filter((name) => !listed.tools.some((tool) => tool.name === name));
    if (missing.length > 0) {
      throw new AgentError(
        'AGENT_MCP_INVALID_CONFIGURATION',
        `MCP did not expose allowlisted tools: ${missing.join(', ')}`,
        { status: 502 },
      );
    }

    clients.set(tools, client);
    return tools;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
};

const clients = new WeakMap<Record<string, AgentToolDefinition>, McpClientLike>();

/** Close the connection retained by mcpTools after its tools are no longer in use. */
export const closeMcpTools = async (tools: Record<string, AgentToolDefinition>): Promise<void> => {
  const client = clients.get(tools);
  clients.delete(tools);
  await client?.close();
};

/** A class the Worker's app defines (`defineCloudflareApp`) that no export extends. */
export interface UnexportedClass {
  readonly kind: 'durable-object' | 'workflow' | 'entrypoint';
  /** What it serves: its host class's name, or `WebSocket` for a gateway room's Durable Object. */
  readonly serves: string;
  /** The RPC methods its `rpc` list names. */
  readonly methods: readonly string[];
}

/**
 * The factory call a class the app defines was built with, as a program would
 * write it: `VelaDurableObject(app, CounterHost, { rpc: ['increment'] })`.
 */
export function definitionOf(defined: UnexportedClass): string {
  if (defined.kind === 'durable-object' && defined.serves === 'WebSocket') {
    return 'VelaWebSocketDurableObject(app)';
  }
  const factory =
    defined.kind === 'workflow'
      ? 'VelaWorkflow'
      : defined.kind === 'entrypoint'
        ? 'VelaEntrypoint'
        : 'VelaDurableObject';
  const rpc =
    defined.methods.length === 0
      ? ''
      : `, { rpc: [${defined.methods.map((method) => `'${method}'`).join(', ')}] }`;
  return `${factory}(app, ${defined.serves}${rpc})`;
}

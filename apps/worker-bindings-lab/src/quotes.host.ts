import { Inject, InjectEnv, Injectable, type VelaEnv } from '@velajs/vela';
import { ENTRYPOINT_PROPS } from '@velajs/cloudflare/entrypoints';

/** The caller a service binding names in its `props`, validated. */
function callerOf(props: unknown): string | null {
  const caller: unknown =
    typeof props === 'object' && props !== null ? Reflect.get(props, 'caller') : undefined;
  return typeof caller === 'string' ? caller : null;
}

/**
 * The Quotes service entrypoint's host. The Quotes class lists `quote` in its
 * `rpc`, so another Worker binding it calls `await env.QUOTES.quote('sku-1')`.
 * Each call runs in the Worker's application, with the binding's `props`
 * injected as ENTRYPOINT_PROPS.
 */
@Injectable()
export class QuotesHost {
  constructor(
    @InjectEnv() private readonly env: VelaEnv,
    @Inject(ENTRYPOINT_PROPS) private readonly props: unknown,
  ) {}

  async quote(sku: string): Promise<{ sku: string; cents: number; caller: string | null }> {
    const stored = await this.env.CACHE.get(`price:${sku}`);
    return { sku, cents: stored === null ? 0 : Number(stored), caller: callerOf(this.props) };
  }
}

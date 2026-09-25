import { getCookie } from 'hono/cookie';
import type { Context } from 'hono';
import { ParamType } from '../constants';
import type { Container } from '../container/container';
import type { ArgumentMetadata, PipeTransform } from '../pipeline/types';
import { instantiateAsync } from './instantiate';
import { readJsonBody } from './json-body';
import type { ParamMetadata, ParamReader } from './types';

type ParamExtractor = (c: Context, param: ParamMetadata) => unknown | Promise<unknown>;

const PARAM_EXTRACTORS = new Map<ParamType, ParamExtractor>([
  [ParamType.PARAM, (c, p) => (p.name ? c.req.param(p.name) : c.req.param())],
  [ParamType.QUERY, (c, p) => (p.name ? c.req.query(p.name) : c.req.query())],
  [
    ParamType.BODY,
    async (c, p) => {
      const body = await readJsonBody(c);
      return p.name && body !== null && typeof body === 'object'
        ? (body as Record<string, unknown>)[p.name]
        : body;
    },
  ],
  [ParamType.HEADERS, (c, p) => (p.name ? c.req.header(p.name) : c.req.header())],
  [ParamType.REQUEST, (c) => c.req.raw],
  [ParamType.CONTEXT, (c) => c],
  [ParamType.RESPONSE, (c) => c],
  [ParamType.COOKIE, (c, p) => (p.name ? getCookie(c, p.name) : getCookie(c))],
  [ParamType.RAW_BODY, async (c) => new Uint8Array(await c.req.arrayBuffer())],
]);

// Pulls handler arguments from the request, then applies shared pipes (global
// + controller + method) and per-param pipes. A route-built reader receives
// every pipe that applies, and names the pipes that do not run on its value.
// Handlers receive only explicitly declared arguments (use @Ctx() for Hono).
export class ArgumentResolver {
  constructor(private readonly ipExtractor: (c: Context) => string | null) {}

  async extract(
    c: Context,
    paramMetadata: ParamMetadata[],
    pipes: PipeTransform[],
    requestContainer: Container,
    paramTypes?: unknown[],
    moduleId?: string,
    /** Route-built readers, by position in `paramMetadata`; they replace the default extraction. */
    extractors: ReadonlyArray<ParamReader | undefined> = [],
  ): Promise<unknown[]> {
    if (paramMetadata.length === 0) {
      return [];
    }

    const maxIndex = paramMetadata.at(-1)!.index;
    const args: unknown[] = new Array(maxIndex + 1).fill(undefined);

    for (const [position, param] of paramMetadata.entries()) {
      let applied = pipes;
      if (param.pipes && param.pipes.length > 0) {
        applied = [...pipes];
        for (const paramPipe of param.pipes)
          applied.push(
            await instantiateAsync<PipeTransform>(paramPipe, requestContainer, moduleId),
          );
      }

      const read = extractors[position];
      let value = await (read ? read(c, applied) : this.extractParam(c, param));

      const metadata: ArgumentMetadata = {
        type: param.type,
        data: param.name,
        metatype: param.metatype ?? paramTypes?.[param.index],
      };

      for (const pipe of applied) {
        if (read?.skips?.(pipe)) continue;
        value = await (pipe.transformAsync
          ? pipe.transformAsync(value, metadata)
          : pipe.transform(value, metadata));
      }

      args[param.index] = value;
    }

    return args;
  }

  private extractParam(c: Context, param: ParamMetadata): unknown | Promise<unknown> {
    if (param.type === ParamType.IP) return this.ipExtractor(c);
    const extractor = PARAM_EXTRACTORS.get(param.type as ParamType);
    if (extractor) return extractor(c, param);
    return param.factory ? param.factory(param.name, c) : undefined;
  }
}

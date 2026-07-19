/**
 * Transfer ops — bulk data export / import over the {@link STUDIO_MODEL_SOURCE}
 * port. Authored on the core `.` entry (no optional peer): a transfer is a
 * data-source operation, so the `transfer` feature lights exactly when a model
 * source is bound (like `data`), and both ops degrade to `FEATURE_UNCONFIGURED`
 * until then.
 *
 * - `transfer.export` returns a URL to the `GET {prefix}/export` route (mounted
 *   in the admin router) — a stream, never an inlined dump, so a large table
 *   never buffers in a dispatch response. A `model` scopes it to one model;
 *   omitted, the route streams every managed model (self-describing markers).
 * - `transfer.import` is DESTRUCTIVE (bulk ingest): it rides the SAME single-use
 *   428 confirm challenge the dispatch registry raises for every `destructive`
 *   op (per `STUDIO_OP_META`), and is `transferImport`-gated. It writes each
 *   NDJSON line through the source's create path and reports per-line errors.
 *
 * The NDJSON streaming helpers here are shared with the `/export` route.
 */
import { Container, Inject, Injectable } from '@velajs/vela';
import type {
  StudioOpReq,
  TransferExportResult,
  TransferImportResult,
} from '@velajs/studio-protocol';
import { STUDIO_EXPORT_SUFFIX } from '@velajs/studio-protocol';
import { AdminConfirmSummary, AdminRpc } from '../rpc/admin-rpc.decorator';
import type { AdminOpContext, ResolvedStudioConfig } from '../studio.types';
import { studioError } from '../studio.errors';
import { STUDIO_RESOLVED_CONFIG } from '../tokens';
import { StudioAppHolder } from '../introspect/app-holder';
import { STUDIO_MODEL_SOURCE } from '../data/model-source.port';
import type { StudioModelSource, StudioWriteContext } from '../data/model-source.port';
import { utf8 } from '../security/crypto';

/** Rows pulled per page while streaming an export (a whole table never buffers). */
const EXPORT_PER_PAGE = 500;

/** The self-describing marker line preceding each model's rows in an all-models export. */
interface ModelMarker {
  __studioModel__: string;
}

/** Join a normalized prefix and a suffix path into one clean `/a/b` path. */
function joinPath(prefix: string, suffix: string): string {
  const head = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const tail = suffix.startsWith('/') ? suffix : `/${suffix}`;
  return `${head}${tail}`;
}

/**
 * A pull-based NDJSON stream of every row of `model` (incl. soft-deleted, for a
 * faithful export). Pages the source `EXPORT_PER_PAGE` rows at a time so at most
 * one page is resident.
 */
export function streamModelNdjson(
  source: StudioModelSource,
  model: string,
): ReadableStream<Uint8Array> {
  let page = 1;
  let finished = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) {
        controller.close();
        return;
      }
      const result = await source.list(model, {
        model,
        page,
        perPage: EXPORT_PER_PAGE,
        withDeleted: true,
      });
      const rows = result.rows;
      if (rows.length === 0) {
        finished = true;
        controller.close();
        return;
      }
      let buf = '';
      for (const row of rows) buf += `${JSON.stringify(row)}\n`;
      controller.enqueue(utf8(buf));
      if (result.info.has_next_page === true && rows.length >= EXPORT_PER_PAGE) page += 1;
      else {
        finished = true;
        controller.close();
      }
    },
  });
}

/**
 * A pull-based NDJSON stream of EVERY managed model: a `{ __studioModel__ }`
 * marker line, then that model's rows, per model. Self-describing so an importer
 * can route rows back to their model.
 */
export function streamAllModelsNdjson(source: StudioModelSource): ReadableStream<Uint8Array> {
  const models = source.listModels().map((m) => m.name);
  let index = 0;
  let rowReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let wroteMarker = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (index >= models.length) {
          controller.close();
          return;
        }
        const model = models[index]!;
        if (!wroteMarker) {
          wroteMarker = true;
          const marker: ModelMarker = { __studioModel__: model };
          controller.enqueue(utf8(`${JSON.stringify(marker)}\n`));
          rowReader = streamModelNdjson(source, model).getReader();
          return;
        }
        const reader = rowReader;
        if (reader === null) {
          index += 1;
          wroteMarker = false;
          continue;
        }
        const { done, value } = await reader.read();
        if (done) {
          rowReader = null;
          index += 1;
          wroteMarker = false;
          continue;
        }
        if (value !== undefined) {
          controller.enqueue(value);
          return;
        }
      }
    },
  });
}

@Injectable()
export class StudioTransferOps {
  constructor(
    @Inject(Container) private readonly container: Container,
    @Inject(STUDIO_RESOLVED_CONFIG) private readonly config: ResolvedStudioConfig,
    @Inject(StudioAppHolder) private readonly holder: StudioAppHolder,
  ) {}

  @AdminRpc({ op: 'transfer.export' })
  export(_ctx: AdminOpContext, args: StudioOpReq<'transfer.export'>): TransferExportResult {
    // Assert a source is bound so `transfer.export` degrades like the data ops
    // rather than handing back a URL to a route that will 404.
    this.source();
    const base = this.config.absolute
      ? this.config.path
      : joinPath(this.holder.globalPrefix, this.config.path);
    const query = args?.model !== undefined ? `?model=${encodeURIComponent(args.model)}` : '';
    return { exportUrl: `${joinPath(base, STUDIO_EXPORT_SUFFIX)}${query}` };
  }

  @AdminRpc({ op: 'transfer.import' })
  async import(
    ctx: AdminOpContext,
    args: StudioOpReq<'transfer.import'>,
  ): Promise<TransferImportResult> {
    const source = this.writableSource();
    // Reject an unknown model ONCE (not per line) — `describe` throws it.
    source.describe(args.model);
    const writeCtx: StudioWriteContext = {};
    const errors: TransferImportResult['errors'] = [];
    let imported = 0;
    let line = 0;
    for (const raw of args.ndjson.split('\n')) {
      const trimmed = raw.trim();
      if (trimmed.length === 0) continue;
      line += 1;
      try {
        const row = JSON.parse(trimmed) as unknown;
        if (typeof row !== 'object' || row === null) throw new Error('line is not a JSON object');
        await source.writeRow!(
          args.model,
          { model: args.model, patch: row as Record<string, unknown> },
          writeCtx,
        );
        imported += 1;
      } catch (error) {
        errors.push({ line, message: error instanceof Error ? error.message : String(error) });
      }
    }
    ctx.audit({
      target: args.model,
      summary: `imported ${imported} row${imported === 1 ? '' : 's'} into ${args.model}`,
      extra: { imported, errorCount: errors.length },
    });
    return { imported, errors };
  }

  @AdminConfirmSummary({ op: 'transfer.import' })
  importSummary(_ctx: AdminOpContext, args: StudioOpReq<'transfer.import'>): string {
    const rows = args.ndjson.split('\n').filter((l) => l.trim().length > 0).length;
    return `import ${rows} row${rows === 1 ? '' : 's'} into ${args.model}`;
  }

  /** The bound source, else `FEATURE_UNCONFIGURED`. */
  private source(): StudioModelSource {
    if (!this.container.has(STUDIO_MODEL_SOURCE)) throw studioError('FEATURE_UNCONFIGURED');
    return this.container.resolve(STUDIO_MODEL_SOURCE);
  }

  /** The bound source, asserted write-capable (import needs a create path). */
  private writableSource(): StudioModelSource {
    const source = this.source();
    if (source.writeRow === undefined) {
      throw studioError('FEATURE_UNCONFIGURED', 'the bound data source is read-only');
    }
    return source;
  }
}

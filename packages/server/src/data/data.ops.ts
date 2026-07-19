/**
 * The data-browser READ ops: `data.listModels`, `data.describeModel`,
 * `data.listRows`, `data.readRow`, `data.facets`, `data.cascadePreview`. Each is
 * a discoverable `@AdminRpc` handler over the {@link STUDIO_MODEL_SOURCE} port —
 * this provider knows nothing about crud.
 *
 * Registered UNCONDITIONALLY by `StudioModule` (so the wire surface is stable),
 * but every handler resolves the source lazily and reports `FEATURE_UNCONFIGURED`
 * when none is bound — mirroring how `app.openapi` reports a missing rootModule.
 * Unknown-model handling belongs to the source (it throws `STUDIO_UNKNOWN_MODEL`).
 *
 * Write ops (`data.writeRow`/`deleteRows`/`clearTable`/`generateRows`) are M7 and
 * intentionally have no handler here.
 */
import { Container, Inject, Injectable } from '@velajs/vela';
import type {
  CascadePreviewRequest,
  CascadePreviewResponse,
  FacetsRequest,
  FacetsResponse,
  ListRowsRequest,
  StudioModelDescriptor,
  StudioModelInfo,
  StudioOpReq,
  StudioRowPage,
} from '@velajs/studio-protocol';
import { AdminRpc } from '../rpc/admin-rpc.decorator';
import type { AdminOpContext } from '../studio.types';
import { studioError } from '../studio.errors';
import { STUDIO_MODEL_SOURCE } from './model-source.port';
import type { StudioModelSource } from './model-source.port';

@Injectable()
export class StudioDataOps {
  constructor(@Inject(Container) private readonly container: Container) {}

  @AdminRpc({ op: 'data.listModels' })
  listModels(_ctx: AdminOpContext): StudioModelInfo[] {
    return this.source().listModels();
  }

  @AdminRpc({ op: 'data.describeModel' })
  describeModel(
    _ctx: AdminOpContext,
    args: StudioOpReq<'data.describeModel'>,
  ): StudioModelDescriptor {
    return this.source().describe(args.model);
  }

  @AdminRpc({ op: 'data.listRows' })
  listRows(_ctx: AdminOpContext, args: ListRowsRequest): Promise<StudioRowPage> {
    return this.source().list(args.model, args);
  }

  @AdminRpc({ op: 'data.readRow' })
  readRow(
    _ctx: AdminOpContext,
    args: StudioOpReq<'data.readRow'>,
  ): Promise<Record<string, unknown> | null> {
    return this.source().readOne(args.model, args.id);
  }

  @AdminRpc({ op: 'data.facets' })
  facets(_ctx: AdminOpContext, args: FacetsRequest): Promise<FacetsResponse> {
    const source = this.source();
    if (source.facets === undefined) {
      throw studioError('FEATURE_UNCONFIGURED', 'facets require an aggregate-capable source');
    }
    return source.facets(args);
  }

  @AdminRpc({ op: 'data.cascadePreview' })
  cascadePreview(
    _ctx: AdminOpContext,
    args: CascadePreviewRequest,
  ): Promise<CascadePreviewResponse> {
    const source = this.source();
    if (source.cascadePreview === undefined) {
      throw studioError('FEATURE_UNCONFIGURED', 'cascade preview requires a relation-aware source');
    }
    return source.cascadePreview(args);
  }

  /** The bound source, or `FEATURE_UNCONFIGURED` when no source module is wired. */
  private source(): StudioModelSource {
    if (!this.container.has(STUDIO_MODEL_SOURCE)) throw studioError('FEATURE_UNCONFIGURED');
    return this.container.resolve(STUDIO_MODEL_SOURCE);
  }
}

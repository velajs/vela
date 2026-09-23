/**
 * `createApp()` — boots the whole Vela Studio product against a real crud data
 * layer, on the Node adapter (no Cloudflare). It wires:
 *
 *  - `StudioModule.forRoot(...)` — the reserved `/_vela/admin` surface, token +
 *    editable gates, and `rootModule` so `app.openapi` lights up.
 *  - `StudioCrudModule` — binds the crud-backed model source (lights `data.*`).
 *  - `StudioTimeTravelModule` — the PORTABLE tier: the in-memory snapshot store +
 *    the model source (granularity `snapshot`; CDC is a documented opt-in seam).
 *  - `StudioFlagsModule` + `FeatureFlagsModule` — the flags panel.
 *  - `StudioScheduleModule` + `ScheduleModule` — the schedule panel (a `@Cron` job).
 *  - `StudioQueueModule` + `QueueModule` — the queues panel (a `@Processor`).
 *  - `studioRuntimeAdapter` — opt-in route attribution (real `Controller#handler`).
 *
 * Every class is declared once, at module scope. Each `createApp()` call builds
 * its own in-memory store and hands its adapters to the graph through
 * `CrudModule.forRoot({ databases })`, so building another application declares
 * no new classes.
 *
 * Auth is intentionally NOT wired (it needs better-auth + a DB); the auth panel
 * therefore reports `FEATURE_UNCONFIGURED` / stays dark — an acceptable demo
 * state the brief permits.
 */
import {
  Controller,
  Cron,
  Get,
  Injectable,
  Module,
  ScheduleModule,
  VelaFactory,
  type DynamicModule,
  type VelaEnv,
} from '@velajs/vela';
import { Process, Processor, QueueModule } from '@velajs/vela/queue';
import { FeatureFlagsModule } from '@velajs/feature-flags';
import { Crud, CrudModule, createCrudDatabaseRegistry, defineCrudDatabase } from '@velajs/crud';
import { StudioModule, readStudioEnv, studioRuntimeAdapter } from '@velajs/studio';
import type { EditableFlags } from '@velajs/studio';
import { StudioCrudModule } from '@velajs/studio/crud';
import { StudioTimeTravelModule } from '@velajs/studio/timetravel';
import { StudioFlagsModule } from '@velajs/studio/flags';
import { StudioScheduleModule } from '@velajs/studio/schedule';
import { StudioQueueModule } from '@velajs/studio/queue';
import { models } from './models';
import { MemoryDb, memoryAdapter } from './memory-adapter';

/** The demo's reserved admin base path. */
export const ADMIN_BASE_PATH = '/_vela/admin';

/** A non-production fallback token (a `VELA_STUDIO_TOKEN` in ENV overrides it). */
export const DEV_TOKEN = 'demo-master-token-change-me';

/** The demo's feature-flag manifest (drives the flags panel). */
export const FLAG_MANIFEST = {
  newDashboard: true,
  betaBanner: false,
  maxUploads: 25,
} as const;

/** The queue the demo registers + its `@Processor`. */
export const DEMO_QUEUE = 'welcome-email';

/** The `@Cron` job method name (what `schedule.runNow` addresses). */
export const CRON_JOB_ID = 'nightlyReport';

/** The named crud database each application registers its in-memory store under. */
export const DEMO_DATABASE = 'demo';

/** Studio's identity for each model: `<database>::<resource>` for a named database. */
export const MODEL_IDS = {
  author: `${DEMO_DATABASE}::author`,
  book: `${DEMO_DATABASE}::book`,
  tag: `${DEMO_DATABASE}::tag`,
} as const;

/** Stable seed identities the walkthrough asserts against. */
export const SEED = {
  authors: ['a1', 'a2', 'a3'] as const,
  liveBooks: ['b1', 'b2', 'b3'] as const,
  softDeletedBook: 'b4' as const,
  tags: ['t1', 't2'] as const,
} as const;

/** Seed a fresh multi-table store: 3 authors, 4 books (one soft-deleted), 2 tags. */
function seed(db: MemoryDb): void {
  db.seed('authors', [
    { id: 'a1', name: 'Ada', email: 'ada@x.io', role: 'admin', createdAt: 1, updatedAt: 1 },
    { id: 'a2', name: 'Bo', email: 'bo@x.io', role: 'member', createdAt: 2, updatedAt: 2 },
    { id: 'a3', name: 'Cy', email: 'cy@x.io', role: 'member', createdAt: 3, updatedAt: 3 },
  ]);
  db.seed('books', [
    {
      id: 'b1',
      title: 'Portable Time',
      authorId: 'a1',
      status: 'published',
      deletedAt: null,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 'b2',
      title: 'Draft Notes',
      authorId: 'a1',
      status: 'draft',
      deletedAt: null,
      createdAt: 2,
      updatedAt: 2,
    },
    {
      id: 'b3',
      title: 'World Tour',
      authorId: 'a2',
      status: 'published',
      deletedAt: null,
      createdAt: 3,
      updatedAt: 3,
    },
    {
      id: 'b4',
      title: 'Tombstoned',
      authorId: 'a1',
      status: 'draft',
      deletedAt: 123,
      createdAt: 4,
      updatedAt: 4,
    },
  ]);
  db.seed('tags', [
    { id: 't1', label: 'fiction', createdAt: 1, updatedAt: 1 },
    { id: 't2', label: 'tech', createdAt: 2, updatedAt: 2 },
  ]);
}

@Controller('/authors')
@Crud({ model: models.author })
class AuthorsController {}

@Controller('/books')
@Crud({ model: models.book, searchFields: ['title'] })
class BooksController {}

@Controller('/tags')
@Crud({ model: models.tag })
class TagsController {}

// A hand-written controller with real HTTP handlers, so `app.routes` can show
// real `Controller#handler` attribution once `studioRuntimeAdapter` is wired.
@Controller('/info')
class InfoController {
  @Get('/')
  root() {
    return { app: 'vela-studio-demo' };
  }

  @Get('/health', { name: 'health' })
  health() {
    return { ok: true };
  }
}

@Injectable()
class Reports {
  ran = 0;
  @Cron('0 0 * * *')
  nightlyReport() {
    this.ran += 1;
  }
}

@Module({ providers: [Reports] })
class ReportsModule {}

@Processor(DEMO_QUEUE)
class WelcomeEmailProcessor {
  handled = 0;
  @Process()
  handle() {
    this.handled += 1;
  }
}

@Module({ providers: [WelcomeEmailProcessor] })
class EmailProcessorModule {}

// `registerQueue` declares its module class per call: register the queue once.
const demoQueueModule = QueueModule.registerQueue({ name: DEMO_QUEUE });

@Module({
  controllers: [AuthorsController, BooksController, TagsController, InfoController],
})
class ApiModule {}

/** Seed a fresh store and register its per-model adapters as the demo database. */
function demoDatabase(): DynamicModule {
  const db = new MemoryDb();
  seed(db);
  const database = defineCrudDatabase(DEMO_DATABASE, {
    handle: db,
    resources: {
      // author: aggregate (facets on `role`) + cascade (preview author→books).
      author: {
        model: models.author,
        adapter: memoryAdapter(models.author, db, ['aggregate', 'cascade']),
      },
      // book: nativeSearch (inline search on title) + soft-delete (from the model).
      book: { model: models.book, adapter: memoryAdapter(models.book, db, ['nativeSearch']) },
      tag: { model: models.tag, adapter: memoryAdapter(models.tag, db, []) },
    },
  });
  return CrudModule.forRoot({
    databases: createCrudDatabaseRegistry([database], { defaultDatabase: DEMO_DATABASE }),
  });
}

/** Options for {@link createApp}. */
export interface CreateAppOptions {
  /** Master admin bearer. Default: `VELA_STUDIO_TOKEN` from `env`, else {@link DEV_TOKEN}. */
  token?: string;
  /**
   * The runtime environment, seeded as the application's `ENV`. Studio reads its
   * `VELA_STUDIO_*` values from it. The Node entry passes `process.env`.
   */
  env?: VelaEnv;
  /** Editable-gate overrides. Default: data + timeTravel + transfer + ops open. */
  editable?: Partial<EditableFlags>;
}

/** The demo's root: static classes, with each application's values in `forRoot`. */
class DemoAppModule {
  static forRoot(token: string | undefined, editable: Partial<EditableFlags>): DynamicModule {
    const studioModule = StudioModule.forRoot({
      path: ADMIN_BASE_PATH,
      ...(token === undefined ? {} : { token }),
      rootModule: ApiModule,
      editable,
    });
    const modelSourceModule = StudioCrudModule.forRoot({});
    return {
      module: DemoAppModule,
      imports: [
        demoDatabase(),
        ApiModule,
        studioModule,
        modelSourceModule,
        StudioTimeTravelModule.forRoot({ imports: [studioModule, modelSourceModule] }),
        FeatureFlagsModule.forRoot({ manifest: { ...FLAG_MANIFEST }, isGlobal: true }),
        StudioFlagsModule.forRoot({}),
        ScheduleModule,
        ReportsModule,
        StudioScheduleModule.forRoot({}),
        QueueModule.forRoot(),
        demoQueueModule,
        EmailProcessorModule,
        StudioQueueModule.forRoot({}),
      ],
    };
  }
}

/** The concrete application type `VelaFactory.create` resolves to. */
export type DemoApp = Awaited<ReturnType<typeof VelaFactory.create>>;

/**
 * Build + initialize the demo app. Each call gets an isolated in-memory store,
 * so callers (tests, the walkthrough) never share mutable state.
 */
export async function createApp(options: CreateAppOptions = {}): Promise<DemoApp> {
  const env = options.env ?? {};
  // Studio reads VELA_STUDIO_TOKEN from ENV itself; supply the demo token only without one.
  const token = options.token ?? (readStudioEnv(env).token === undefined ? DEV_TOKEN : undefined);
  const editable: Partial<EditableFlags> = {
    data: true,
    timeTravel: true,
    transfer: true,
    ops: true,
    ...options.editable,
  };

  return VelaFactory.create(DemoAppModule.forRoot(token, editable), {
    env,
    adapters: [studioRuntimeAdapter],
  });
}

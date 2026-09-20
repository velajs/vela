import { defineCrudFeature } from '@velajs/crud';
/**
 * Harbor inventory API — the full-surface @velajs/crud example.
 *
 * Shows both consumption styles:
 * - a DECORATED controller (`/containers`): hooks, a hand-written route
 *   coexisting with generated ones, an `@Override`, and a guard;
 * - a HEADLESS resource (`/berths`) mounted via `CrudModule.forFeature`.
 */
import { z } from 'zod';
import {
  Controller,
  Get,
  Module,
  UseGuards,
  VelaFactory,
  type CanActivate,
  type ExecutionContext,
} from '@velajs/vela';
import {
  Crud,
  CrudCtx,
  CrudModule,
  Override,
  defineModel,
  type CrudRequestContext,
} from '@velajs/crud';
import { clearMemoryStorage, getStore, memoryAdapter } from '@velajs/crud-memory';

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export const Container = defineModel({
  name: 'container',
  tableName: 'containers',
  schema: z.object({
    id: z.uuid(),
    code: z.string().min(4),
    weightKg: z.number().int().positive(),
    hazardous: z.boolean().default(false),
    createdAt: z.number().optional(),
    updatedAt: z.number().optional(),
    deletedAt: z.number().nullable().optional(),
  }),
  softDelete: true,
});

export const Berth = defineModel({
  name: 'berth',
  tableName: 'berths',
  schema: z.object({
    id: z.uuid(),
    label: z.string().min(1),
    depthM: z.number().positive(),
    createdAt: z.number().optional(),
    updatedAt: z.number().optional(),
    deletedAt: z.number().nullable().optional(),
  }),
  softDelete: true,
});

// ---------------------------------------------------------------------------
// A guard on the decorated controller (runs on every generated route too)
// ---------------------------------------------------------------------------

class HarborKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    return context.getRequest().headers.get('X-Harbor-Key') === 'letmein';
  }
}

// ---------------------------------------------------------------------------
// Decorated controller: /containers
// ---------------------------------------------------------------------------

@Controller('/containers')
@UseGuards(HarborKeyGuard)
@Crud({
  model: Container,
  adapter: memoryAdapter({ tableName: 'containers', softDeleteField: 'deletedAt' }),
  filterFields: ['code', 'weightKg', 'hazardous'],
  sortFields: ['weightKg'],
  searchFields: ['code'],
  hooks: {
    // Normalize codes on the way in; the returned value replaces the payload.
    beforeCreate: (_ctx, data) => ({ ...data, code: String(data.code).toUpperCase() }),
  },
})
export class ContainersController {
  /** Hand-written route — registered BEFORE the generated `/:id`. */
  @Get('/stats')
  stats() {
    return { total: getStore('containers').size };
  }

  /** First-class takeover of the generated list (keeps the route name). */
  @Override('list')
  list(@CrudCtx() ctx: CrudRequestContext) {
    const rows = [...getStore('containers').values()].filter((row) => row.deletedAt == null);
    return {
      success: true,
      result: rows,
      result_info: { note: 'served by @Override', requestPath: ctx.c.req.path },
    };
  }
}

// ---------------------------------------------------------------------------
// App: decorated controller + headless /berths
// ---------------------------------------------------------------------------

@Module({
  controllers: [ContainersController],
  imports: [
    CrudModule.forRoot({
      adapter: memoryAdapter({ tableName: 'berths', softDeleteField: 'deletedAt' }),
    }),
    CrudModule.forFeature([
      defineCrudFeature({ path: '/berths', model: Berth, only: ['create', 'list', 'read', 'delete'] }),
    ]),
  ],
})
export class AppModule {}

export async function createApp() {
  clearMemoryStorage();
  return VelaFactory.create(AppModule);
}

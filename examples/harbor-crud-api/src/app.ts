import type { Context } from 'hono';
import { z } from 'zod';
import {
  Controller,
  Get,
  Injectable,
  Module,
  UseGuards,
  VelaFactory,
  MetadataRegistry,
} from '@velajs/vela';
import type { CanActivate, ExecutionContext, VelaApplication } from '@velajs/vela';
import { Crud, CrudModule, CrudService, Override } from '@velajs/crud';
import type { CrudConfig } from '@velajs/crud';
import {
  MemoryAdapters,
  defineMeta,
  defineModel,
} from 'hono-crud';
import * as HonoCrud from 'hono-crud';
import type { AdapterBundle, MetaInput } from 'hono-crud';

interface HarborFixture {
  app: VelaApplication;
}

const ContainerSchema = z.object({
  id: z.string(),
  code: z.string(),
  status: z.enum(['arrived', 'loaded', 'departed']),
  terminal: z.string(),
  weightTons: z.number(),
});

const CreateContainerSchema = z.object({
  code: z.string().min(3),
  status: z.enum(['arrived', 'loaded', 'departed']).default('arrived'),
  terminal: z.string().default('north'),
  weightTons: z.number().positive(),
});

const UpdateContainerSchema = z.object({
  status: z.enum(['arrived', 'loaded', 'departed']),
  terminal: z.string().optional(),
  weightTons: z.number().positive().optional(),
});

const BerthSchema = z.object({
  id: z.string(),
  name: z.string(),
  vessel: z.string(),
});

const ContainerModel = defineModel({
  tableName: 'harbor_containers',
  schema: ContainerSchema,
  primaryKeys: ['id'],
});

const BerthModel = defineModel({
  tableName: 'harbor_berths',
  schema: BerthSchema,
  primaryKeys: ['id'],
});

const containerMeta = defineMeta({ model: ContainerModel }) as MetaInput;
const berthMeta = defineMeta({ model: BerthModel }) as MetaInput;
const adapters = MemoryAdapters as AdapterBundle;
const clearHonoCrudStorage = (HonoCrud as typeof HonoCrud & {
  clearStorage?: () => void;
}).clearStorage;

class HarborGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    return context.getRequest().headers.get('x-harbor-key') === 'harbor-secret';
  }
}

const containerCrudConfig: CrudConfig = {
  meta: containerMeta,
  adapters,
  dto: {
    create: CreateContainerSchema,
    update: UpdateContainerSchema,
  },
  hooks: {
    beforeCreate: (data) => {
      const payload = data as z.infer<typeof CreateContainerSchema>;
      return {
        ...payload,
        code: payload.code.toUpperCase(),
      };
    },
    afterList: (items) =>
      items.map((item) => ({
        ...(item as Record<string, unknown>),
        inspected: true,
      })),
  },
};

export async function createHarborCrudApp(): Promise<HarborFixture> {
  MetadataRegistry.clear();
  clearHonoCrudStorage?.();

  @Injectable()
  class ContainerCrudService extends CrudService {
    readonly meta = containerMeta;
    readonly adapters = adapters;
  }

  @Controller('/containers')
  @UseGuards(new HarborGuard())
  @Crud(containerCrudConfig)
  class ContainerController {
    @Get('/dashboard')
    dashboard() {
      return {
        resource: 'containers',
        endpoints: ['create', 'list', 'read', 'update', 'delete'],
      };
    }
  }

  @Controller('/container-reports')
  @Crud({
    meta: containerMeta,
    adapters,
    only: ['list'],
  })
  class ContainerReportsController {
    @Override('list')
    async customList(c: Context) {
      return c.json({
        result: [],
        override: true,
        terminal: c.req.query('terminal') ?? 'all',
      });
    }
  }

  @Controller('/meta')
  class MetaController {
    constructor(private readonly crud: ContainerCrudService) {}

    @Get('/container-resource')
    resource() {
      return {
        hasMeta: Boolean(this.crud.meta),
        hasAdapters: Boolean(this.crud.adapters),
      };
    }
  }

  @Module({
    imports: [
      CrudModule.forResource('/berths', {
        meta: berthMeta,
        adapters,
        only: ['create', 'list'],
        guards: [new HarborGuard()],
      }),
    ],
    providers: [ContainerCrudService],
    controllers: [ContainerController, ContainerReportsController, MetaController],
  })
  class HarborCrudModule {}

  const app = await VelaFactory.create(HarborCrudModule, {
    globalPrefix: '/api',
  });

  return { app };
}

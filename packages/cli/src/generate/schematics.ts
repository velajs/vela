import type { Names } from './names.js';

/**
 * The source each schematic writes. Generated code uses the application kit
 * from `@velajs/vela`, feature subpaths (`/queue`, `/schedule`), `ENV` for
 * bindings, and plain decorator routes with schema arguments.
 */

/** How relative imports end in this project: `.js`, `.ts` or nothing. */
export type ImportExtension = '.js' | '.ts' | '';

export function moduleSource(name: Names): string {
  return `import { Module } from '@velajs/vela';

@Module({})
export class ${name.pascal}Module {}
`;
}

export function controllerSource(name: Names): string {
  return `import { Controller, Get } from '@velajs/vela';

@Controller('/${name.kebab}')
export class ${name.pascal}Controller {
  @Get()
  list() {
    return [];
  }
}
`;
}

export function serviceSource(name: Names): string {
  return `import { Injectable } from '@velajs/vela';

@Injectable()
export class ${name.pascal}Service {}
`;
}

export function cronSource(name: Names, schedule: string): string {
  return `import { Injectable, Logger } from '@velajs/vela';
import { Cron, type CronInvocation } from '@velajs/vela/schedule';

@Injectable()
export class ${name.pascal}Cron {
  readonly #logger = new Logger(${name.pascal}Cron.name);

  // Runs on the Wrangler cron trigger with the same expression, in UTC with
  // Cloudflare's weekday numbering. \`vela cf sync --write\` declares it.
  @Cron('${schedule}', { dialect: 'cloudflare' })
  run(tick: CronInvocation): void {
    this.#logger.log(\`Running for \${new Date(tick.scheduledTime).toISOString()}\`);
  }
}
`;
}

export function processorSource(name: Names): string {
  return `import { Logger } from '@velajs/vela';
import { Process, Processor, type QueueJob } from '@velajs/vela/queue';

/** The logical queue: QueueModule.registerQueue({ name }) and @Processor(name). */
export const ${name.constant}_QUEUE = '${name.kebab}';

// Cloudflare delivers the queue's batches to the Worker; QueueModule routes
// each job here and acknowledges it once the handler resolves. A handler that
// throws leaves the message to be retried.
@Processor(${name.constant}_QUEUE)
export class ${name.pascal}Processor {
  readonly #logger = new Logger(${name.pascal}Processor.name);

  // Handles every job of the queue; @Process(defineQueueJob(name, schema))
  // handles one validated job instead.
  @Process()
  handle(job: QueueJob): void {
    this.#logger.log(\`Processing \${job.name} \${job.id}\`);
  }
}
`;
}

export function durableObjectHostSource(name: Names): string {
  return `import { Inject, Injectable } from '@velajs/vela';
import { DO_STORAGE } from '@velajs/cloudflare/durable-objects';

/**
 * The ${name.pascal} Durable Object's host: one instance per id, with its own
 * storage. Its public methods are the object's RPC methods, typed on its
 * binding: \`await env.${name.constant}.getByName('id').increment()\`. Keep
 * helpers in #private methods or other providers.
 */
@Injectable()
export class ${name.pascal}Host {
  constructor(@Inject(DO_STORAGE) private readonly storage: DurableObjectStorage) {}

  async increment(): Promise<number> {
    const value = ((await this.storage.get<number>('value')) ?? 0) + 1;
    await this.storage.put('value', value);
    return value;
  }
}
`;
}

/**
 * The Durable Object class the Worker entry exports: \`rootImport\` imports
 * the root module as \`rootName\`, \`hostFrom\` is the host file's specifier.
 */
export function durableObjectSource(
  name: Names,
  rootName: string,
  rootImport: string,
  hostFrom: string,
): string {
  return `import { VelaDurableObject } from '@velajs/cloudflare/durable-objects';
${rootImport}
import { ${name.pascal}Host } from '${hostFrom}';

// Each instance boots ${rootName} with ${name.pascal}Host as one of its providers. The
// host's public methods are this class's RPC methods, and its guards, pipes,
// interceptors and filters run around every call.
export class ${name.pascal} extends VelaDurableObject(${rootName}, ${name.pascal}Host) {}
`;
}

/** The files `vela generate resource` writes, relative to the resource directory. */
export function resourceSources(
  name: Names,
  entity: Names,
  ext: ImportExtension,
  zod: boolean,
): Record<string, string> {
  const Entity = entity.pascal;
  const types = zod ? `${entity.kebab}.schemas` : `${entity.kebab}.types`;
  const schemas = zod
    ? `import { z } from 'zod';

export const ${Entity} = z.object({
  id: z.string(),
  name: z.string(),
});
export type ${Entity} = z.infer<typeof ${Entity}>;

export const Create${Entity} = z.object({
  name: z.string().trim().min(1).max(200),
});
export type Create${Entity} = z.infer<typeof Create${Entity}>;

export const Update${Entity} = Create${Entity}.partial();
export type Update${Entity} = z.infer<typeof Update${Entity}>;
`
    : `import { BadRequestException } from '@velajs/vela';

export interface ${Entity} {
  id: string;
  name: string;
}

export interface Create${Entity} {
  name: string;
}

export type Update${Entity} = Partial<Create${Entity}>;

// Request bodies come from outside the program: validate them before use.
function readName(body: object): string | undefined {
  if (!('name' in body) || typeof body.name !== 'string') return undefined;
  const name = body.name.trim();
  return name.length > 0 && name.length <= 200 ? name : undefined;
}

function readObject(body: unknown): object {
  if (typeof body !== 'object' || body === null) {
    throw new BadRequestException('Expected a JSON object.');
  }
  return body;
}

export function parseCreate${Entity}(body: unknown): Create${Entity} {
  const name = readName(readObject(body));
  if (name === undefined) throw new BadRequestException('name must be 1 to 200 characters.');
  return { name };
}

export function parseUpdate${Entity}(body: unknown): Update${Entity} {
  const object = readObject(body);
  if (!('name' in object)) return {};
  const name = readName(object);
  if (name === undefined) throw new BadRequestException('name must be 1 to 200 characters.');
  return { name };
}
`;
  const typeImport = zod
    ? `import { Create${Entity}, Update${Entity}, type ${Entity} } from './${types}${ext}';`
    : `import {
  parseCreate${Entity},
  parseUpdate${Entity},
  type ${Entity},
} from './${types}${ext}';`;
  const createParam = zod
    ? `@Body(Create${Entity}) body: Create${Entity}`
    : '@Body() body: unknown';
  const updateParam = zod
    ? `@Body(Update${Entity}) body: Update${Entity}`
    : '@Body() body: unknown';
  const createInput = zod ? 'body' : `parseCreate${Entity}(body)`;
  const updateInput = zod ? 'body' : `parseUpdate${Entity}(body)`;
  const service = `${name.pascal}Service`;
  return {
    [`${types}.ts`]: schemas,
    [`${name.kebab}.service.ts`]: `import { Injectable } from '@velajs/vela';
import type { Create${Entity}, ${Entity}, Update${Entity} } from './${types}${ext}';

// The Map lives in one isolate. Keep the data in a binding (KV, D1, a Durable
// Object) read through ENV to share it across isolates and deployments.
@Injectable()
export class ${service} {
  readonly #items = new Map<string, ${Entity}>();

  findAll(): ${Entity}[] {
    return [...this.#items.values()];
  }

  findOne(id: string): ${Entity} | undefined {
    return this.#items.get(id);
  }

  create(input: Create${Entity}): ${Entity} {
    const item: ${Entity} = { id: crypto.randomUUID(), ...input };
    this.#items.set(item.id, item);
    return item;
  }

  update(id: string, input: Update${Entity}): ${Entity} | undefined {
    const existing = this.#items.get(id);
    if (!existing) return undefined;
    const item: ${Entity} = { ...existing, ...input };
    this.#items.set(id, item);
    return item;
  }

  remove(id: string): boolean {
    return this.#items.delete(id);
  }
}
`,
    [`${name.kebab}.controller.ts`]: `import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@velajs/vela';
${typeImport}
import { ${service} } from './${name.kebab}.service${ext}';

@Controller('/${name.kebab}')
export class ${name.pascal}Controller {
  readonly #service: ${service};

  constructor(service: ${service}) {
    this.#service = service;
  }

  @Get()
  findAll(): ${Entity}[] {
    return this.#service.findAll();
  }

  @Get('/:id')
  findOne(@Param('id') id: string): ${Entity} {
    const item = this.#service.findOne(id);
    if (!item) throw new NotFoundException(\`${Entity} \${id} not found\`);
    return item;
  }

  @Post()
  create(${createParam}): ${Entity} {
    return this.#service.create(${createInput});
  }

  @Patch('/:id')
  update(@Param('id') id: string, ${updateParam}): ${Entity} {
    const item = this.#service.update(id, ${updateInput});
    if (!item) throw new NotFoundException(\`${Entity} \${id} not found\`);
    return item;
  }

  @Delete('/:id')
  @HttpCode(204)
  remove(@Param('id') id: string): void {
    if (!this.#service.remove(id)) throw new NotFoundException(\`${Entity} \${id} not found\`);
  }
}
`,
    [`${name.kebab}.module.ts`]: `import { Module } from '@velajs/vela';
import { ${name.pascal}Controller } from './${name.kebab}.controller${ext}';
import { ${service} } from './${name.kebab}.service${ext}';

@Module({
  controllers: [${name.pascal}Controller],
  providers: [${service}],
})
export class ${name.pascal}Module {}
`,
  };
}

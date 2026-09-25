import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  APP_GUARD,
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  Post,
  Query,
  Reflector,
  UseGuards,
  UseInterceptors,
  VelaFactory,
  defineProvider,
  type CallHandler,
  type CanActivate,
  type ExecutionContext,
  type NestInterceptor,
} from '../index.js';
import { SkipGuardPhases } from '../module-kit.js';
import { createOpenApiDocument } from '../openapi/index.js';

// Declarations on an ancestor class apply to the controllers that extend it,
// as reflect-metadata resolves them in Nest: class-level metadata and
// enhancers along the class chain, and method-level ones on a method the
// controller inherits unchanged. An override reads only its own.

const Roles = Reflector.createDecorator<string[]>();

let trace: string[] = [];
beforeEach(() => {
  trace = [];
});

// A dependency, so a guard that injects it resolves only through the module
// loader's registration of the enhancers its classes declare or inherit.
@Injectable()
class Verdict {
  allow = false;
}

@Injectable()
class VerdictGuard implements CanActivate {
  constructor(@Inject(Verdict) private readonly verdict: Verdict) {}

  canActivate(): boolean {
    trace.push('verdict');
    return this.verdict.allow;
  }
}

@Injectable()
class TraceInterceptor implements NestInterceptor {
  async intercept(_context: ExecutionContext, next: CallHandler): Promise<unknown> {
    trace.push('intercept');
    return next.handle();
  }
}

function tracedGuard(name: string, allow = true) {
  class TracedGuard implements CanActivate {
    canActivate(): boolean {
      trace.push(name);
      return allow;
    }
  }
  return TracedGuard;
}

describe('declarations inherited from an ancestor method', () => {
  it('serves a routed inherited method with the route options an ancestor declares on it', async () => {
    const Public = z.object({ id: z.string() });

    class Base {
      @Get({ response: Public })
      get() {
        return { id: '1', passwordHash: 'secret' };
      }

      @Post({ status: 202 })
      queue() {
        return { queued: true };
      }
    }
    const inherited = Object.getOwnPropertyDescriptor(Base.prototype, 'get')!;
    @Controller('/inherited')
    class Inherited extends Base {}
    Get()(Inherited.prototype, 'get', inherited);
    Post()(Inherited.prototype, 'queue', Object.getOwnPropertyDescriptor(Base.prototype, 'queue')!);
    // Its own override reads only its own declarations, and so do its own options.
    @Controller('/override')
    class Override extends Base {
      @Get()
      override get() {
        return { id: '2', passwordHash: 'own' };
      }
    }
    @Controller('/restated')
    class Restated extends Base {}
    Get({ response: z.looseObject({ id: z.string() }) })(Restated.prototype, 'get', inherited);

    // Siblings sharing an undecorated method: only the one that declares it strips.
    class Shared {
      get() {
        return { id: '3', passwordHash: 'shared' };
      }
    }
    const shared = Object.getOwnPropertyDescriptor(Shared.prototype, 'get')!;
    @Controller('/strict')
    class Strict extends Shared {}
    Get({ response: Public })(Strict.prototype, 'get', shared);
    @Controller('/loose')
    class Loose extends Shared {}
    Get()(Loose.prototype, 'get', shared);

    @Module({ controllers: [Inherited, Override, Restated, Strict, Loose] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const body = async (path: string) => (await app.getHonoApp().request(path)).json();
    try {
      expect(await body('/inherited')).toEqual({ id: '1' });
      const queued = await app.getHonoApp().request('/inherited', { method: 'POST' });
      expect(queued.status).toBe(202);
      expect(await body('/override')).toEqual({ id: '2', passwordHash: 'own' });
      expect(await body('/restated')).toEqual({ id: '1', passwordHash: 'secret' });
      expect(await body('/strict')).toEqual({ id: '3' });
      expect(await body('/loose')).toEqual({ id: '3', passwordHash: 'shared' });

      const document = createOpenApiDocument(AppModule);
      expect(document.paths['/inherited']!.get!.responses['200']).toMatchObject({
        content: { 'application/json': { schema: { type: 'object', properties: { id: {} } } } },
      });
      expect(Object.keys(document.paths['/inherited']!.post!.responses)).toEqual(['202']);
      expect(document.paths['/loose']!.get!.responses['200']).not.toHaveProperty('content');
    } finally {
      await app.close();
    }
  });

  it('reads the parameters an ancestor declares on a routed inherited method', async () => {
    class Note {
      static schema = z.object({ text: z.string().min(1) });
      declare text: string;
    }
    class Base {
      create(@Body() body: Note, @Query('tag') tag: string) {
        return { text: body.text, tag: tag ?? null };
      }
    }
    @Controller('/notes')
    class Notes extends Base {}
    Post()(Notes.prototype, 'create', Object.getOwnPropertyDescriptor(Base.prototype, 'create')!);
    @Module({ controllers: [Notes] })
    class AppModule {}
    const app = await VelaFactory.create(AppModule);
    const post = (body: unknown) =>
      app.getHonoApp().request('/notes?tag=a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    try {
      expect((await post({ text: '' })).status).toBe(400);
      const created = await post({ text: 'hi' });
      expect(created.status).toBe(201);
      expect(await created.json()).toEqual({ text: 'hi', tag: 'a' });
      const document = createOpenApiDocument(AppModule);
      expect(document.paths['/notes']!.post!.parameters).toEqual([
        { name: 'tag', in: 'query', required: false, schema: { type: 'string' } },
      ]);
    } finally {
      await app.close();
    }
  });

  it('runs the guards and interceptors an ancestor declares on a routed inherited method', async () => {
    const OwnGuard = tracedGuard('own');
    const RefuseGuard = tracedGuard('refuse', false);

    class Base {
      @UseGuards(VerdictGuard)
      @UseInterceptors(TraceInterceptor)
      list() {
        return ['listed'];
      }
    }
    const inherited = Object.getOwnPropertyDescriptor(Base.prototype, 'list')!;
    @Controller('/reports')
    class Reports extends Base {}
    Get()(Reports.prototype, 'list', inherited);
    // Two levels down, through a class that declares nothing.
    class Middle extends Base {}
    @Controller('/archive')
    class Archive extends Middle {}
    Get()(Archive.prototype, 'list', inherited);
    // A guard the controller adds to the inherited method runs after the ancestor's.
    @Controller('/audited')
    class Audited extends Base {}
    Get()(Audited.prototype, 'list', inherited);
    UseGuards(OwnGuard)(Audited.prototype, 'list', inherited);
    // Its own override runs only its own.
    @Controller('/members')
    class Members extends Base {
      @Get()
      override list() {
        return ['members'];
      }
    }

    // Siblings sharing an undecorated method: a guard one declares never runs for the other.
    class Shared {
      list() {
        return ['shared'];
      }
    }
    const shared = Object.getOwnPropertyDescriptor(Shared.prototype, 'list')!;
    @Controller('/restricted')
    class Restricted extends Shared {}
    Get()(Restricted.prototype, 'list', shared);
    UseGuards(RefuseGuard)(Restricted.prototype, 'list', shared);
    @Controller('/open')
    class Open extends Shared {}
    Get()(Open.prototype, 'list', shared);

    @Module({
      controllers: [Reports, Archive, Audited, Members, Restricted, Open],
      providers: [Verdict],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const status = async (path: string) => {
      trace = [];
      return (await app.getHonoApp().request(path)).status;
    };
    try {
      expect(await status('/reports')).toBe(403);
      expect(trace).toEqual(['verdict']);
      expect(await status('/archive')).toBe(403);
      expect(await status('/audited')).toBe(403);
      expect(await status('/members')).toBe(200);
      expect(trace).toEqual([]);
      expect(await status('/restricted')).toBe(403);
      expect(trace).toEqual(['refuse']);
      expect(await status('/open')).toBe(200);
      expect(trace).toEqual([]);

      app.get(Verdict).allow = true;
      expect(await status('/reports')).toBe(200);
      expect(trace).toEqual(['verdict', 'intercept']);
      expect(await status('/audited')).toBe(200);
      expect(trace).toEqual(['verdict', 'own', 'intercept']);
    } finally {
      await app.close();
    }
  });
});

describe('declarations inherited from an ancestor class', () => {
  it('reads class metadata an ancestor declares through every Reflector form', async () => {
    const seen: Array<Array<string[] | undefined>> = [];

    @Injectable()
    class RolesGuard implements CanActivate {
      constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

      canActivate(context: ExecutionContext): boolean {
        seen.push([
          this.reflector.get(Roles, context),
          this.reflector.getClass(Roles, context),
          this.reflector.getAll(Roles, context)[1],
          this.reflector.get(Roles, context.getClass()),
          this.reflector.getAllAndOverride(Roles, [context.getHandler(), context.getClass()]),
        ]);
        const roles = this.reflector.getAllAndOverride(Roles, context);
        const role = context.getRequest().headers.get('x-role') ?? '';
        return roles === undefined || roles.includes(role);
      }
    }

    @Roles(['admin'])
    abstract class AdminBase {}
    @Controller('/users')
    class Users extends AdminBase {
      @Get()
      list() {
        return ['users'];
      }
    }
    // Two levels down, through a class that declares nothing.
    abstract class Staff extends AdminBase {}
    @Controller('/staff')
    class StaffUsers extends Staff {
      @Get()
      list() {
        return ['staff'];
      }
    }
    // The nearest class declaration wins.
    @Controller('/editors')
    @Roles(['editor'])
    class Editors extends AdminBase {
      @Get()
      list() {
        return ['editors'];
      }
    }
    // Method metadata still takes priority over inherited class metadata.
    @Controller('/profile')
    class Profile extends AdminBase {
      @Get()
      @Roles(['member'])
      read() {
        return ['profile'];
      }
    }
    @Controller('/open')
    class Open {
      @Get()
      list() {
        return ['open'];
      }
    }

    @Module({
      controllers: [Users, StaffUsers, Editors, Profile, Open],
      providers: [RolesGuard, defineProvider(APP_GUARD, { useExisting: RolesGuard })],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const status = async (path: string, role: string) =>
      (await app.getHonoApp().request(path, { headers: { 'x-role': role } })).status;
    try {
      expect(await status('/users', 'member')).toBe(403);
      expect(seen.at(-1)).toEqual([['admin'], ['admin'], ['admin'], ['admin'], ['admin']]);
      expect(await status('/users', 'admin')).toBe(200);
      expect(await status('/staff', 'member')).toBe(403);
      expect(await status('/staff', 'admin')).toBe(200);
      expect(await status('/editors', 'admin')).toBe(403);
      expect(seen.at(-1)).toEqual([['editor'], ['editor'], ['editor'], ['editor'], ['editor']]);
      expect(await status('/editors', 'editor')).toBe(200);
      expect(await status('/profile', 'admin')).toBe(403);
      expect(await status('/profile', 'member')).toBe(200);
      expect(await status('/open', 'member')).toBe(200);
      expect(seen.at(-1)).toEqual([undefined, undefined, undefined, undefined, undefined]);
    } finally {
      await app.close();
    }
  });

  it('runs the class-level guards and interceptors an ancestor declares, ancestors first', async () => {
    const OwnGuard = tracedGuard('own');

    @UseGuards(VerdictGuard)
    @UseInterceptors(TraceInterceptor)
    abstract class Locked {}
    @Controller('/locked')
    class LockedReports extends Locked {
      @Get()
      list() {
        return ['locked'];
      }
    }
    @Controller('/audited')
    @UseGuards(OwnGuard)
    class AuditedReports extends Locked {
      @Get()
      list() {
        return ['audited'];
      }
    }
    @Controller('/open')
    class OpenReports {
      @Get()
      list() {
        return ['open'];
      }
    }

    @Module({ controllers: [LockedReports, AuditedReports, OpenReports], providers: [Verdict] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const status = async (path: string) => {
      trace = [];
      return (await app.getHonoApp().request(path)).status;
    };
    try {
      expect(await status('/locked')).toBe(403);
      expect(trace).toEqual(['verdict']);
      expect(await status('/audited')).toBe(403);
      expect(await status('/open')).toBe(200);
      expect(trace).toEqual([]);

      app.get(Verdict).allow = true;
      expect(await status('/locked')).toBe(200);
      expect(trace).toEqual(['verdict', 'intercept']);
      expect(await status('/audited')).toBe(200);
      expect(trace).toEqual(['verdict', 'own', 'intercept']);
    } finally {
      await app.close();
    }
  });

  it('reads inherited declarations without invoking an ancestor accessor', async () => {
    // Map.prototype.size throws for any receiver that is not a Map instance.
    @Injectable()
    class Registry extends Map<string, number> {}
    class Accessors {
      get current(): string {
        throw new Error('accessor invoked');
      }
      @UseGuards(tracedGuard('refuse', false))
      list() {
        return ['listed'];
      }
    }
    @Controller('/accessors')
    class AccessorReports extends Accessors {}
    Get()(
      AccessorReports.prototype,
      'list',
      Object.getOwnPropertyDescriptor(Accessors.prototype, 'list')!,
    );

    @Module({ controllers: [AccessorReports], providers: [Registry] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    try {
      expect(app.get(Registry).size).toBe(0);
      expect((await app.getHonoApp().request('/accessors')).status).toBe(403);
      expect(trace).toEqual(['refuse']);
    } finally {
      await app.close();
    }
  });

  it('skips the guard phases an ancestor class or inherited method leaves to its integration', async () => {
    class PolicyGuard implements CanActivate {
      static readonly phase = 'authorize';
      static readonly skippable = true;
      canActivate(): boolean {
        trace.push('policy');
        return false;
      }
    }

    @SkipGuardPhases(['authorize'])
    abstract class IntegrationBase {}
    @Controller('/integration')
    class Integration extends IntegrationBase {
      @Get()
      get() {
        return 'integration';
      }
    }
    class Handlers {
      @SkipGuardPhases(['authorize'])
      get() {
        return 'handled';
      }
    }
    const inherited = Object.getOwnPropertyDescriptor(Handlers.prototype, 'get')!;
    @Controller('/handled')
    class Handled extends Handlers {}
    Get()(Handled.prototype, 'get', inherited);
    // Its own override is not marked.
    @Controller('/overridden')
    class Overridden extends Handlers {
      @Get()
      override get() {
        return 'overridden';
      }
    }

    @Module({ controllers: [Integration, Handled, Overridden] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    app.useGlobalGuards(new PolicyGuard());
    const status = async (path: string) => {
      trace = [];
      return (await app.getHonoApp().request(path)).status;
    };
    try {
      expect(await status('/integration')).toBe(200);
      expect(trace).toEqual([]);
      expect(await status('/handled')).toBe(200);
      expect(trace).toEqual([]);
      expect(await status('/overridden')).toBe(403);
      expect(trace).toEqual(['policy']);
    } finally {
      await app.close();
    }
  });
});

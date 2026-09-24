import { describe, expect, it, vi } from 'vitest';
import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  Reflector,
  SetMetadata,
  UseGuards,
  VelaFactory,
  type CanActivate,
  type ExecutionContext,
} from '../index.js';

const Roles = Reflector.createDecorator<string[]>();
const Audience = Reflector.createDecorator<string, ReadonlySet<string>>({
  transform: (value) => new Set(value.split(',')),
});

// Reading through a function that serves several methods with different metadata.
const REFUSED = "Reflector cannot read metadata through the handler function 'list'";

// A read's result, or the message it throws.
function attempt(read: () => unknown): string {
  try {
    return JSON.stringify(read());
  } catch (error) {
    return error instanceof Error ? error.message.slice(0, REFUSED.length) : String(error);
  }
}

// Replaces the method it decorates, as logging and tracing decorators do.
function wrap(_target: object, _key: string | symbol, descriptor: PropertyDescriptor): void {
  const method: unknown = descriptor.value;
  descriptor.value = function wrapped(this: unknown, ...args: unknown[]): unknown {
    return typeof method === 'function' ? Reflect.apply(method, this, args) : undefined;
  };
}

describe("Reflector accepts Nest's (key, target | target[]) signatures", () => {
  it('reads handler and class metadata from getHandler() and getClass()', async () => {
    const seen: Array<{
      handlerName: string | symbol;
      handlerIsMethod: boolean;
      fromHandler: string[] | undefined;
      fromClass: string[] | undefined;
      handlerOnly: string[] | undefined;
      override: string[] | undefined;
      merged: string[] | string[][];
      viaContext: string[] | undefined;
    }> = [];

    @Injectable()
    class RolesGuard implements CanActivate {
      constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

      canActivate(context: ExecutionContext): boolean {
        const handler = context.getHandler();
        seen.push({
          handlerName: context.getHandlerName(),
          handlerIsMethod:
            handler === Reflect.get(context.getClass().prototype, context.getHandlerName()),
          fromHandler: this.reflector.get(Roles, handler),
          fromClass: this.reflector.get(Roles, context.getClass()),
          handlerOnly: this.reflector.getAllAndOverride(Roles, [handler]),
          override: this.reflector.getAllAndOverride(Roles, [handler, context.getClass()]),
          merged: this.reflector.getAllAndMerge(Roles, [handler, context.getClass()]),
          viaContext: this.reflector.get(Roles, context),
        });
        return true;
      }
    }

    @Controller('/reports')
    @Roles(['reader'])
    @UseGuards(RolesGuard)
    class ReportsController {
      @Get()
      @Roles(['admin'])
      list() {
        return [];
      }

      @Get('/public')
      open() {
        return [];
      }
    }

    @Module({ controllers: [ReportsController], providers: [RolesGuard] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect((await app.getHonoApp().request('/reports')).status).toBe(200);
    expect((await app.getHonoApp().request('/reports/public')).status).toBe(200);
    expect(seen).toEqual([
      {
        handlerName: 'list',
        handlerIsMethod: true,
        fromHandler: ['admin'],
        fromClass: ['reader'],
        handlerOnly: ['admin'],
        override: ['admin'],
        merged: ['admin', 'reader'],
        viaContext: ['admin'],
      },
      {
        handlerName: 'open',
        handlerIsMethod: true,
        fromHandler: undefined,
        fromClass: ['reader'],
        handlerOnly: undefined,
        override: ['reader'],
        merged: ['reader'],
        viaContext: ['reader'],
      },
    ]);
  });

  it('reads a function several controllers decorate only together with its controller', async () => {
    const seen: Array<{
      viaContext: string[] | undefined;
      withClass: string[] | undefined;
      single: string;
      handlerOnly: string;
    }> = [];

    @Injectable()
    class RolesGuard implements CanActivate {
      constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

      canActivate(context: ExecutionContext): boolean {
        const handler = context.getHandler();
        const roles = this.reflector.getAllAndOverride(Roles, [handler, context.getClass()]);
        seen.push({
          viaContext: this.reflector.getAllAndOverride(Roles, context),
          withClass: roles,
          single: attempt(() => this.reflector.get(Roles, handler)),
          handlerOnly: attempt(() => this.reflector.getAllAndOverride(Roles, [handler])),
        });
        return !roles?.length;
      }
    }

    class Docs {
      list() {
        return { listed: true };
      }
    }
    class AdminDocs extends Docs {}
    class PublicDocs extends Docs {}
    // Both controllers decorate the one inherited method without decorator syntax.
    const shared = Object.getOwnPropertyDescriptor(Docs.prototype, 'list')!;
    Controller('/admin')(AdminDocs);
    Get()(AdminDocs.prototype, 'list', shared);
    Roles(['admin'])(AdminDocs.prototype, 'list', shared);
    Controller('/public')(PublicDocs);
    Get()(PublicDocs.prototype, 'list', shared);
    Roles([])(PublicDocs.prototype, 'list', shared);
    for (const controller of [AdminDocs, PublicDocs]) UseGuards(RolesGuard)(controller);

    @Module({ controllers: [AdminDocs, PublicDocs], providers: [RolesGuard] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    // Listed with the function, the controller names the method it routes.
    expect((await app.getHonoApp().request('/admin')).status).toBe(403);
    expect((await app.getHonoApp().request('/public')).status).toBe(200);
    // Alone, the function cannot say which controller it serves: the read fails closed.
    expect(seen).toEqual([
      { viaContext: ['admin'], withClass: ['admin'], single: REFUSED, handlerOnly: REFUSED },
      { viaContext: [], withClass: [], single: REFUSED, handlerOnly: REFUSED },
    ]);
    expect(() => new Reflector().get(Roles, Docs.prototype.list)).toThrow(REFUSED);
  });

  it('refuses a single function target that sibling controllers route with different metadata', async () => {
    const IsPublic = Reflector.createDecorator<boolean>();
    const reads: Array<(reflector: Reflector, context: ExecutionContext) => boolean | undefined> = [
      (reflector, context) => reflector.get(IsPublic, context.getHandler()),
      (reflector, context) => reflector.getAllAndOverride(IsPublic, [context.getHandler()]),
    ];
    for (const read of reads) {
      @Injectable()
      class PublicOnlyGuard implements CanActivate {
        constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

        canActivate(context: ExecutionContext): boolean {
          return read(this.reflector, context) === true;
        }
      }

      class Base {
        list() {
          return { listed: true };
        }
      }
      class PublicDocs extends Base {}
      class PrivateDocs extends Base {}
      // Only PublicDocs marks the inherited method both controllers route.
      const shared = Object.getOwnPropertyDescriptor(Base.prototype, 'list')!;
      Controller('/public')(PublicDocs);
      Get()(PublicDocs.prototype, 'list', shared);
      IsPublic(true)(PublicDocs.prototype, 'list', shared);
      Controller('/private')(PrivateDocs);
      Get()(PrivateDocs.prototype, 'list', shared);
      for (const controller of [PublicDocs, PrivateDocs]) UseGuards(PublicOnlyGuard)(controller);

      @Module({ controllers: [PublicDocs, PrivateDocs], providers: [PublicOnlyGuard] })
      class AppModule {}

      const app = await VelaFactory.create(AppModule, { diagnostics: 'silent' });
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        // Both routes are recorded at startup, so neither request guesses.
        expect((await app.getHonoApp().request('/public')).status).toBe(500);
        expect((await app.getHonoApp().request('/private')).status).toBe(500);
      } finally {
        errors.mockRestore();
      }
      expect(() => new Reflector().get(IsPublic, Base.prototype.list)).toThrow(REFUSED);
      expect(new Reflector().getAllAndOverride(IsPublic, [Base.prototype.list, PublicDocs])).toBe(
        true,
      );
    }
  });

  it('reads the metadata of a method a later decorator wraps', async () => {
    const seen: Array<Array<string[] | undefined>> = [];

    @Injectable()
    class RolesGuard implements CanActivate {
      constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

      canActivate(context: ExecutionContext): boolean {
        const handler = context.getHandler();
        const reads = [
          this.reflector.get(Roles, handler),
          this.reflector.getAllAndOverride(Roles, [handler]),
          this.reflector.getAllAndOverride(Roles, [handler, context.getClass()]),
          this.reflector.get(Roles, context),
        ];
        seen.push(reads);
        // As in Nest's RolesGuard, a route without roles is open; this caller has none.
        return reads.every((roles) => roles === undefined);
      }
    }

    @Controller('/reports')
    @UseGuards(RolesGuard)
    class ReportsController {
      @Get()
      @wrap
      @Roles(['admin'])
      list() {
        return [];
      }

      @wrap
      @Get('/archive')
      @Roles(['admin'])
      archive() {
        return [];
      }
    }

    @Module({ controllers: [ReportsController], providers: [RolesGuard] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect((await app.getHonoApp().request('/reports')).status).toBe(403);
    expect((await app.getHonoApp().request('/reports/archive')).status).toBe(403);
    expect(seen).toEqual([
      [['admin'], ['admin'], ['admin'], ['admin']],
      [['admin'], ['admin'], ['admin'], ['admin']],
    ]);
  });

  it("reads a shared handler's metadata only for the controller that declares or inherits it", async () => {
    const IsPublic = Reflector.createDecorator<boolean>();

    @Injectable()
    class PublicOnlyGuard implements CanActivate {
      constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

      canActivate(context: ExecutionContext): boolean {
        return (
          this.reflector.getAllAndOverride(IsPublic, [context.getHandler(), context.getClass()]) ===
          true
        );
      }
    }

    class Base {
      list() {
        return { listed: true };
      }
    }
    class PublicDocs extends Base {}
    class PrivateDocs extends Base {}
    // Only PublicDocs decorates the one inherited method, without decorator syntax.
    const shared = Object.getOwnPropertyDescriptor(Base.prototype, 'list')!;
    Controller('/public')(PublicDocs);
    Get()(PublicDocs.prototype, 'list', shared);
    IsPublic(true)(PublicDocs.prototype, 'list', shared);
    Controller('/private')(PrivateDocs);
    Get()(PrivateDocs.prototype, 'list', shared);

    // A controller inheriting a method its ancestor decorates keeps the metadata.
    class Catalog {
      @IsPublic(true)
      list() {
        return { listed: true };
      }
    }
    class CatalogDocs extends Catalog {}
    Controller('/catalog')(CatalogDocs);
    Get()(
      CatalogDocs.prototype,
      'list',
      Object.getOwnPropertyDescriptor(Catalog.prototype, 'list')!,
    );

    for (const controller of [PublicDocs, PrivateDocs, CatalogDocs])
      UseGuards(PublicOnlyGuard)(controller);

    @Module({
      controllers: [PublicDocs, PrivateDocs, CatalogDocs],
      providers: [PublicOnlyGuard],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect((await app.getHonoApp().request('/public')).status).toBe(200);
    expect((await app.getHonoApp().request('/private')).status).toBe(403);
    expect((await app.getHonoApp().request('/catalog')).status).toBe(200);

    const reflector = new Reflector();
    expect(reflector.getAll(IsPublic, [Base.prototype.list, PrivateDocs])).toEqual([
      undefined,
      undefined,
    ]);
    expect(reflector.getAllAndMerge(IsPublic, [Base.prototype.list, PrivateDocs])).toEqual([]);
    expect(reflector.getAllAndOverride(IsPublic, [Base.prototype.list, PublicDocs])).toBe(true);
  });

  it('resolves string keys set with SetMetadata on handler functions', () => {
    class Plain {
      @SetMetadata('scope', 'write')
      update() {}
    }
    const reflector = new Reflector();
    expect(reflector.get<string>('scope', Plain.prototype.update)).toBe('write');
    expect(reflector.get<string>('scope', Plain)).toBeUndefined();
    expect(reflector.getAll<string>('scope', [Plain.prototype.update, Plain])).toEqual([
      'write',
      undefined,
    ]);
  });

  it('stores the transformed value from createDecorator({ transform })', () => {
    @Audience('staff,partners')
    class Portal {
      @Audience('staff')
      internal() {}
    }
    const reflector = new Reflector();
    const handler: ReadonlySet<string> | undefined = reflector.get(
      Audience,
      Portal.prototype.internal,
    );
    const owner: ReadonlySet<string> | undefined = reflector.get(Audience, Portal);
    expect([...(handler ?? [])]).toEqual(['staff']);
    expect([...(owner ?? [])]).toEqual(['staff', 'partners']);
  });
});

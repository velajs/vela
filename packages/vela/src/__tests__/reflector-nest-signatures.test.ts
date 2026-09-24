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

describe("Reflector accepts Nest's (key, target | target[]) signatures", () => {
  it('reads handler and class metadata from getHandler() and getClass()', async () => {
    const seen: Array<{
      handlerName: string | symbol;
      handlerIsMethod: boolean;
      fromHandler: string[] | undefined;
      fromClass: string[] | undefined;
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
        override: ['admin'],
        merged: ['admin', 'reader'],
        viaContext: ['admin'],
      },
      {
        handlerName: 'open',
        handlerIsMethod: true,
        fromHandler: undefined,
        fromClass: ['reader'],
        override: ['reader'],
        merged: ['reader'],
        viaContext: ['reader'],
      },
    ]);
  });

  it('refuses to read through a handler function several controllers decorate', async () => {
    const seen: Array<string[] | undefined> = [];

    @Injectable()
    class RolesGuard implements CanActivate {
      constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

      canActivate(context: ExecutionContext): boolean {
        seen.push(this.reflector.getAllAndOverride(Roles, context));
        const roles = this.reflector.getAllAndOverride(Roles, [
          context.getHandler(),
          context.getClass(),
        ]);
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

    const app = await VelaFactory.create(AppModule, { diagnostics: 'silent' });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // The function cannot say which controller it serves, so the read fails closed.
      expect((await app.getHonoApp().request('/admin')).status).toBe(500);
      expect((await app.getHonoApp().request('/public')).status).toBe(500);
    } finally {
      errors.mockRestore();
    }
    // The execution context still names the controller.
    expect(seen).toEqual([['admin'], []]);
    expect(() => new Reflector().get(Roles, Docs.prototype.list)).toThrow(
      "Reflector cannot read metadata through the handler function 'list'",
    );
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

import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Context, Next } from 'hono';
import {
  Controller,
  Get,
  Inject,
  Injectable,
  InjectionToken,
  Module,
  defineProvider,
  type MiddlewareConsumer,
  type NestMiddleware,
  type NestModule,
  type Token,
} from '@velajs/vela';
import { UnresolvedDependencyError } from '@velajs/vela/module-kit';
import { OpenApiModule } from '@velajs/vela/openapi';
import { Test } from '../test.js';

const STORE = new InjectionToken<{ read(): string }>('store');

@Module({
  providers: [defineProvider(STORE, { useValue: { read: () => 'database' } })],
  exports: [STORE],
})
class DatabaseModule {}

@Module({
  providers: [defineProvider(STORE, { useValue: { read: () => 'memory' } })],
  exports: [STORE],
})
class MemoryStoreModule {}

@Injectable()
class NotesService {
  constructor(@Inject(STORE) private readonly store: { read(): string }) {}
  read(): string {
    return this.store.read();
  }
}

@Module({ imports: [DatabaseModule], providers: [NotesService], exports: [NotesService] })
class NotesModule {}

describe('overrideModule().useModule()', () => {
  it('replaces an imported module wherever the graph imports it', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [NotesModule] })
      .overrideModule(DatabaseModule)
      .useModule(MemoryStoreModule)
      .compile();
    try {
      expect(moduleRef.get(NotesService).read()).toBe('memory');
    } finally {
      await moduleRef.close();
    }
  });

  it('accepts a dynamic replacement, and the last override of a module wins', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [NotesModule] })
      .overrideModule(DatabaseModule)
      .useModule(MemoryStoreModule)
      .overrideModule(DatabaseModule)
      .useModule({
        module: MemoryStoreModule,
        providers: [defineProvider(STORE, { useValue: { read: () => 'dynamic' } })],
        exports: [STORE],
      })
      .compile();
    try {
      expect(moduleRef.get(NotesService).read()).toBe('dynamic');
    } finally {
      await moduleRef.close();
    }
  });
});

describe('useMocker()', () => {
  @Injectable()
  class Mailer {
    send(to: string): string {
      return `sent to ${to}`;
    }
  }

  const CLOCK = new InjectionToken<{ now(): number }>('clock');

  @Injectable()
  class SignupService {
    constructor(
      readonly mailer: Mailer,
      @Inject(CLOCK) readonly clock: { now(): number },
    ) {}
    signup(email: string): string {
      return `${this.mailer.send(email)} at ${this.clock.now()}`;
    }
  }

  @Controller('/signup')
  class SignupController {
    constructor(private readonly signup: SignupService) {}
    @Get()
    run() {
      return { result: this.signup.signup('a@example.com') };
    }
  }

  it('supplies every dependency no provider satisfies, once per token', async () => {
    const requested: Token[] = [];
    const moduleRef = await Test.createTestingModule({
      controllers: [SignupController],
      providers: [SignupService],
    })
      .useMocker((token) => {
        requested.push(token);
        if (token === CLOCK) return { now: () => 7 };
        if (token === Mailer) return { send: (to: string) => `mocked ${to}` };
        return undefined;
      })
      .compile();
    try {
      expect(requested).toEqual([Mailer, CLOCK]);
      expect(moduleRef.get(SignupService).signup('b@example.com')).toBe(
        'mocked b@example.com at 7',
      );
      const mailer = moduleRef.get(Mailer);
      expectTypeOf(mailer).toEqualTypeOf<Mailer>();
      expect(mailer).toBe(moduleRef.get(SignupService).mailer);
      const response = await moduleRef.http.get('/signup').send();
      response.assertOk().assertJson({ result: 'mocked a@example.com at 7' });
    } finally {
      await moduleRef.close();
    }
  });

  it('leaves a dependency unresolved when the mocker returns nothing for it, as in Nest', async () => {
    const requested: Token[] = [];
    const compiling = Test.createTestingModule({ providers: [SignupService] })
      .useMocker((token) => {
        requested.push(token);
        return token === Mailer ? { send: (to: string) => `mocked ${to}` } : undefined;
      })
      .compile();
    const error = await compiling.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(UnresolvedDependencyError);
    expect(error).toMatchObject({ className: 'SignupService', token: CLOCK });
    expect(requested).toEqual([Mailer, CLOCK]);
  });

  it('leaves provided and overridden tokens to their providers', async () => {
    const requested: Token[] = [];
    const moduleRef = await Test.createTestingModule({
      providers: [SignupService, Mailer, defineProvider(CLOCK, { useValue: { now: () => 0 } })],
    })
      .overrideProvider(CLOCK)
      .useValue({ now: () => 1 })
      .useMocker((token) => requested.push(token))
      .compile();
    try {
      expect(requested).toEqual([]);
      expect(moduleRef.get(SignupService).signup('c')).toBe('sent to c at 1');
    } finally {
      await moduleRef.close();
    }
  });
});

describe('module classes that configure middleware (NestModule)', () => {
  interface Audit {
    record(path: string): void;
  }
  const AUDIT = new InjectionToken<Audit>('audit');

  @Controller('/audited')
  class AuditedController {
    @Get()
    read() {
      return { ok: true };
    }
  }

  // Its configure() reads a constructor dependency.
  const auditing = (audit: Audit): NestMiddleware => ({
    async use(c: Context, next: Next) {
      audit.record(c.req.path);
      await next();
    },
  });

  it('supplies the constructor dependencies of a module class from useMocker', async () => {
    @Module({ controllers: [AuditedController] })
    class AuditedModule implements NestModule {
      constructor(@Inject(AUDIT) private readonly audit: Audit) {}
      configure(consumer: MiddlewareConsumer): void {
        consumer.apply(auditing(this.audit)).forRoutes(AuditedController);
      }
    }
    const recorded: string[] = [];
    const moduleRef = await Test.createTestingModule({ imports: [AuditedModule] })
      .useMocker((token) =>
        token === AUDIT ? { record: (path: string) => recorded.push(path) } : undefined,
      )
      .compile();
    try {
      (await moduleRef.http.get('/audited').send()).assertOk();
      expect(recorded).toEqual(['/audited']);
    } finally {
      await moduleRef.close();
    }
  });

  it('builds a module class with the overridden providers it injects', async () => {
    @Module({
      providers: [defineProvider(AUDIT, { useValue: { record: () => {} } })],
      exports: [AUDIT],
    })
    class AuditModule {}
    @Module({ imports: [AuditModule], controllers: [AuditedController] })
    class AuditedModule implements NestModule {
      constructor(@Inject(AUDIT) private readonly audit: Audit) {}
      configure(consumer: MiddlewareConsumer): void {
        consumer.apply(auditing(this.audit)).forRoutes(AuditedController);
      }
    }
    const recorded: string[] = [];
    const moduleRef = await Test.createTestingModule({ imports: [AuditedModule] })
      .overrideProvider(AUDIT)
      .useValue({ record: (path: string) => recorded.push(path) })
      .compile();
    try {
      (await moduleRef.http.get('/audited').send()).assertOk();
      expect(recorded).toEqual(['/audited']);
    } finally {
      await moduleRef.close();
    }
  });
});

describe('OpenApiModule after overrideModule()', () => {
  @Controller('/legacy')
  class LegacyController {
    @Get()
    list() {
      return [];
    }
  }
  @Module({ controllers: [LegacyController] })
  class LegacyModule {}

  @Controller('/replacement')
  class ReplacementController {
    @Get()
    list() {
      return [];
    }
  }
  @Module({ controllers: [ReplacementController] })
  class ReplacementModule {}

  it("documents the replaced module's routes, as the application serves them", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [LegacyModule, OpenApiModule.forRoot({ path: '/openapi.json' })],
    })
      .overrideModule(LegacyModule)
      .useModule(ReplacementModule)
      .compile();
    try {
      (await moduleRef.http.get('/legacy').send()).assertStatus(404);
      (await moduleRef.http.get('/replacement').send()).assertOk();
      const response = await moduleRef.http.get('/openapi.json').send();
      response.assertOk();
      const document: unknown = await response.json();
      const paths: unknown =
        typeof document === 'object' && document !== null ? Reflect.get(document, 'paths') : {};
      expect(Object.keys(typeof paths === 'object' && paths !== null ? paths : {})).toEqual([
        '/replacement',
      ]);
    } finally {
      await moduleRef.close();
    }
  });
});

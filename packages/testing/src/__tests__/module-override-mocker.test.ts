import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  Controller,
  Get,
  Inject,
  Injectable,
  InjectionToken,
  Module,
  defineProvider,
  type Token,
} from '@velajs/vela';
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

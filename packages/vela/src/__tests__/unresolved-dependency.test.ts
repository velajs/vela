import { describe, expect, it } from 'vitest';
import {
  Container,
  Controller,
  Inject,
  Injectable,
  InjectionToken,
  Module,
  ModuleRef,
  ModuleVisibilityError,
  UnresolvedDependencyError,
  VelaFactory,
  defineProvider,
  forwardRef,
} from '../index';
import type { ModuleScope } from '../internal';

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject');
}

function thrownBy(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the action to throw');
}

function unresolved(error: unknown): UnresolvedDependencyError {
  if (error instanceof UnresolvedDependencyError) return error;
  throw error;
}

function scope(moduleId: string, overrides: Partial<ModuleScope> = {}): ModuleScope {
  return {
    moduleId,
    localProviders: new Set(),
    importedModules: new Set(),
    exportedTokens: new Set(),
    isGlobal: false,
    ...overrides,
  };
}

@Injectable()
class UsersService {}

@Injectable()
class AuditService {}

@Controller('/users')
class UsersController {
  constructor(
    readonly users: UsersService,
    readonly audit: AuditService,
  ) {}
}

describe('UnresolvedDependencyError', () => {
  it('names the class, its module and a provider its declaring module does not export', async () => {
    @Module({ providers: [UsersService] })
    class DataModule {}
    @Module({ imports: [DataModule], controllers: [UsersController], providers: [AuditService] })
    class UsersModule {}

    const error = unresolved(await rejectionOf(VelaFactory.create(UsersModule)));
    expect(error.message).toBe(
      'Cannot resolve UsersController(?, AuditService) in UsersModule. Argument #0 UsersService ' +
        'is declared in DataModule but not exported (add it to DataModule.exports).',
    );
    expect(error.name).toBe('UnresolvedDependencyError');
    expect(error.className).toBe('UsersController');
    expect(error.moduleId).toBe('UsersModule#default');
    expect(error.parameterIndex).toBe(0);
    expect(error.token).toBe(UsersService);
    expect(error.reason).toEqual({ kind: 'not-exported', modules: ['DataModule#default'] });
    expect(error.cause).toBeInstanceOf(ModuleVisibilityError);
  });

  it('suggests importing a module that exports the provider elsewhere in the graph', async () => {
    @Module({ providers: [UsersService], exports: [UsersService] })
    class DataModule {}
    @Module({ controllers: [UsersController], providers: [AuditService] })
    class UsersModule {}
    @Module({ imports: [DataModule, UsersModule] })
    class AppModule {}

    const error = unresolved(await rejectionOf(VelaFactory.create(AppModule)));
    expect(error.message).toBe(
      'Cannot resolve UsersController(?, AuditService) in UsersModule. Argument #0 UsersService ' +
        'is exported by DataModule, which UsersModule does not import (add DataModule to ' +
        'UsersModule.imports).',
    );
    expect(error.reason).toEqual({ kind: 'not-imported', modules: ['DataModule#default'] });
  });

  it('reports a token no module provides, for any argument position', async () => {
    const CLOCK = new InjectionToken<() => number>('CLOCK');

    @Injectable()
    class ReportService {
      constructor(
        readonly users: UsersService,
        @Inject(CLOCK) readonly clock: () => number,
      ) {}
    }
    @Module({ providers: [UsersService, ReportService] })
    class ReportsModule {}

    const error = unresolved(await rejectionOf(VelaFactory.create(ReportsModule)));
    expect(error.message).toBe(
      'Cannot resolve ReportService(UsersService, ?) in ReportsModule. Argument #1 ' +
        'InjectionToken(CLOCK) is not provided in ReportsModule or its imports.',
    );
    expect(error.reason).toEqual({ kind: 'not-provided' });
    expect(error.parameterIndex).toBe(1);
    expect(error.token).toBe(CLOCK);
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('wraps only the innermost constructor that cannot be satisfied', async () => {
    @Injectable()
    class Repository {
      constructor(readonly users: UsersService) {}
    }
    @Injectable()
    class Facade {
      constructor(readonly repository: Repository) {}
    }
    @Module({ providers: [Repository, Facade] })
    class FeatureModule {}

    const error = unresolved(await rejectionOf(VelaFactory.create(FeatureModule)));
    expect(error.className).toBe('Repository');
    expect(error.message).toMatch(/^Cannot resolve Repository\(\?\) in FeatureModule\./);
    expect(error.cause).not.toBeInstanceOf(UnresolvedDependencyError);
  });

  it('wraps the synchronous engine, with the requesting module scope', () => {
    const container = new Container();
    container.registerScope(scope('data', { localProviders: new Set([UsersService]) }));
    container.registerScope(
      scope('users', {
        localProviders: new Set([UsersController, AuditService]),
        importedModules: new Set(['data']),
      }),
    );
    container.register(UsersService, 'data');
    container.register(AuditService, 'users');
    container.register(UsersController, 'users');

    const error = unresolved(thrownBy(() => container.resolve(UsersController, 'users')));
    expect(error.message).toBe(
      'Cannot resolve UsersController(?, AuditService) in users. Argument #0 UsersService is ' +
        'declared in data but not exported (add it to data.exports).',
    );
    expect(error.cause).toBeInstanceOf(ModuleVisibilityError);
  });

  it('describes a class registered on the root container', () => {
    const container = new Container();
    container.register(UsersController);
    container.register(AuditService);

    const error = unresolved(thrownBy(() => container.resolve(UsersController)));
    expect(error.message).toBe(
      'Cannot resolve UsersController(?, AuditService) in the root container. Argument #0 ' +
        'UsersService is not provided by any module.',
    );
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.cause).not.toBeInstanceOf(UnresolvedDependencyError);
  });

  it('covers classes built by ModuleRef.create()', async () => {
    @Injectable()
    class ControllerFactory {
      constructor(readonly moduleRef: ModuleRef) {}
    }
    @Module({ providers: [AuditService, ControllerFactory] })
    class AppModule {}
    const app = await VelaFactory.create(AppModule);
    try {
      const { moduleRef } = app.get(ControllerFactory);
      const error = unresolved(await rejectionOf(moduleRef.create(UsersController)));
      expect(error.message).toBe(
        'Cannot resolve UsersController(?, AuditService) in AppModule. Argument #0 UsersService ' +
          'is not provided in AppModule or its imports.',
      );
    } finally {
      await app.dispose();
    }
  });

  it('describes forwardRef arguments and leaves provider factories unwrapped', async () => {
    const REPORT = new InjectionToken<string>('REPORT');

    @Injectable()
    class Inbox {
      constructor(
        @Inject(forwardRef(() => AuditService)) readonly audit: AuditService,
        readonly users: UsersService,
      ) {}
    }
    @Module({ providers: [AuditService, Inbox] })
    class InboxModule {}
    const error = unresolved(await rejectionOf(VelaFactory.create(InboxModule)));
    expect(error.message).toMatch(/^Cannot resolve Inbox\(AuditService, \?\) in InboxModule\./);

    @Module({
      providers: [
        defineProvider(REPORT, {
          useFactory: async (users: UsersService) => String(users),
          inject: [UsersService],
        }),
      ],
    })
    class FactoryModule {}
    const factoryError = await rejectionOf(VelaFactory.create(FactoryModule));
    expect(factoryError).not.toBeInstanceOf(UnresolvedDependencyError);
    expect(factoryError).toBeInstanceOf(Error);
  });
});

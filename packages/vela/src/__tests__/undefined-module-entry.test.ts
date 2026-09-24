import { describe, expect, it } from 'vitest';
import { Controller, Get, Injectable, Module, VelaFactory } from '../index';
import { UndefinedModuleError, sideEffectModule } from '../module-kit';
import { createOpenApiDocument } from '../openapi/index';
import type { Type } from '../index';

// A circular file import leaves the importing side holding a binding the other
// module has not initialized yet: typed as the class, `undefined` at runtime.
// oxlint-disable-next-line no-unassigned-vars -- the unassigned binding is the fixture
let circular!: Type;

@Module({})
class First {}

@Injectable()
class Service {}

@Controller('/health')
class HealthController {
  @Get()
  get(): string {
    return 'ok';
  }
}

describe('UndefinedModuleError', () => {
  it('names the module, list and index of an undefined import', async () => {
    @Module({ imports: [First, First, circular] })
    class AppModule {}

    const error = await VelaFactory.create(AppModule).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UndefinedModuleError);
    expect(error).toMatchObject({
      moduleName: 'AppModule',
      property: 'imports',
      index: 2,
      message:
        'AppModule.imports[2] is undefined — usually a circular file import; use forwardRef(() => X)',
    });
  });

  it('guards providers and controllers', async () => {
    @Module({ providers: [Service, circular] })
    class ProvidersModule {}
    await expect(VelaFactory.create(ProvidersModule)).rejects.toThrow(
      /^ProvidersModule\.providers\[1\] is undefined — usually a circular file import/,
    );

    @Module({ controllers: [circular, HealthController] })
    class ControllersModule {}
    await expect(VelaFactory.create(ControllersModule)).rejects.toThrow(
      /^ControllersModule\.controllers\[0\] is undefined — usually a circular file import/,
    );
  });

  it('guards dynamic module contributions', async () => {
    class Contributions {}
    @Module({ imports: [sideEffectModule(Contributions, { providers: [circular] })] })
    class AppModule {}
    await expect(VelaFactory.create(AppModule)).rejects.toThrow(
      /^Contributions\.providers\[0\] is undefined/,
    );
  });

  it('guards the metadata-only module walk', () => {
    @Module({ imports: [circular], controllers: [HealthController] })
    class AppModule {}
    expect(() => createOpenApiDocument(AppModule)).toThrow(UndefinedModuleError);
  });
});

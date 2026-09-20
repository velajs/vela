import { describe, expect, it } from 'vitest';
import {
  Container,
  Controller,
  Get,
  Injectable,
  Module,
  UseGuards,
  VelaFactory,
  createParamDecorator,
} from '../index.js';
import type { CanActivate, ExecutionContext } from '../index.js';

describe('ExecutionContext declaring module', () => {
  it('exposes the routed controller module to guards and param decorators', async () => {
    let guardedModuleId: string | undefined;

    @Injectable()
    class CaptureModuleGuard implements CanActivate {
      canActivate(context: ExecutionContext): boolean {
        guardedModuleId = context.getModuleId();
        return true;
      }
    }

    const DeclaringModuleId = createParamDecorator((_data: unknown, context: ExecutionContext) =>
      context.getModuleId(),
    );

    @Controller('/module-context')
    class ModuleContextController {
      @Get()
      @UseGuards(CaptureModuleGuard)
      get(@DeclaringModuleId() moduleId: string) {
        return { moduleId };
      }
    }

    @Module({ providers: [CaptureModuleGuard], controllers: [ModuleContextController] })
    class FeatureModule {}

    @Module({ imports: [FeatureModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const owner = app.get(Container).getOwnerModuleIds(ModuleContextController)[0];
    const response = await app.getHonoApp().request('/module-context');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ moduleId: owner });
    expect(guardedModuleId).toBe(owner);
    expect(owner).toBeTruthy();
  });
});

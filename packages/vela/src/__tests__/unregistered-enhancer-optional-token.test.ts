import { describe, expect, it } from 'vitest';
import { Container } from '../container/container';
import { instantiate } from '../http/instantiate';
import {
  Controller,
  Get,
  Inject,
  InjectionToken,
  Module,
  Optional,
  UseGuards,
  VelaFactory,
  defineProvider,
} from '../index';
import type { CanActivate, Type } from '../index';

interface AccessPolicy {
  allows(): boolean;
}

const ACCESS_POLICY = new InjectionToken<AccessPolicy>('optional enhancer access policy');

// Never listed in a module's providers. Without a configured policy it lets
// requests through by design; a configured policy must be consulted.
class PolicyGuard implements CanActivate {
  constructor(@Optional() @Inject(ACCESS_POLICY) readonly policy?: AccessPolicy) {}

  canActivate(): boolean {
    return this.policy?.allows() ?? true;
  }
}

@Controller('/reports')
class ReportsController {
  @Get()
  @UseGuards(PolicyGuard)
  list() {
    return { reports: [] };
  }
}

const denyAll = defineProvider(ACCESS_POLICY, { useValue: { allows: () => false } });

async function statusOf(module: Type, globalGuards: Type<CanActivate>[] = []): Promise<number> {
  const app = await VelaFactory.create(module);
  app.useGlobalGuards(...globalGuards);
  const response = await app.getHonoApp().request('/reports');
  await app.close();
  return response.status;
}

describe('unregistered enhancer with an optional token', () => {
  it('injects a registered optional token into a guard referenced by class', async () => {
    @Module({ providers: [denyAll], controllers: [ReportsController] })
    class AppModule {}

    expect(await statusOf(AppModule)).toBe(403);
  });

  it('injects a registered optional token into a global guard referenced by class', async () => {
    @Controller('/reports')
    class OpenReportsController {
      @Get()
      list() {
        return { reports: [] };
      }
    }
    @Module({ providers: [denyAll], controllers: [OpenReportsController] })
    class AppModule {}

    expect(await statusOf(AppModule, [PolicyGuard])).toBe(403);
  });

  it('leaves the optional slot empty when nothing registers the token', async () => {
    @Module({ controllers: [ReportsController] })
    class AppModule {}

    expect(await statusOf(AppModule)).toBe(200);
  });

  it('refuses a synchronous bare construction that would skip the optional token', () => {
    const container = new Container({ diagnostics: 'silent' });
    container.register(denyAll);

    expect(() => instantiate(PolicyGuard, container)).toThrow(
      /Cannot instantiate PolicyGuard synchronously: .*optional enhancer access policy.*Add it to a module's providers/,
    );
  });
});

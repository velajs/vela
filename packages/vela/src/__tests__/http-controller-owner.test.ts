import { describe, expect, it } from 'vitest';
import { Container } from '../container/container';
import { Controller, Get } from '../http/decorators';
import { RouteManager } from '../http/route.manager';

describe('HTTP controller registration ownership', () => {
  it('requires an exact owner for ambiguous registrations and preserves chainability', () => {
    @Controller('/owned')
    class Routes {
      @Get() get() {
        return 'ok';
      }
    }
    const container = new Container();
    container.register(Routes, 'first');
    container.register(Routes, 'second');
    const manager = new RouteManager(container);
    expect(() => manager.registerController(Routes)).toThrow('specify its declaring module');
    expect(() => manager.registerController(Routes, 'missing')).toThrow('not registered in module');
    expect(manager.registerController(Routes, 'second')).toBe(manager);
    expect(manager.getControllers()[0]?.moduleId).toBe('second');
    expect(() => manager.registerController(Routes, 'first')).toThrow('already mounted by module');
  });

  it('retains standalone root controller registration', () => {
    @Controller('/standalone')
    class Routes {}
    const manager = new RouteManager(new Container());
    expect(manager.registerController(Routes)).toBe(manager);
    expect(manager.getControllers()[0]?.moduleId).toBe('__root__');
  });
});

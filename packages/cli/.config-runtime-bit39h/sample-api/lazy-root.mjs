
      import { Controller, Get, Module } from '@velajs/vela';
      class Health { ok() { return { ok: true }; } }
      Get('health')(Health.prototype, 'ok', Object.getOwnPropertyDescriptor(Health.prototype, 'ok'));
      Controller('lazy')(Health);
      export class Root {}
      Module({ controllers: [Health] })(Root);
    
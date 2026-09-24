
      import { VelaFactory } from '@velajs/vela';
      import { AppModule } from './src/app.module.js';
      const prefix: string = '/typed';
      export const config = { rootModule: AppModule, createApp: () => VelaFactory.create(AppModule, { globalPrefix: prefix }) };
    
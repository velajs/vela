
      import { VelaFactory } from '@velajs/vela';
      export default {
        async createApp() {
          const { AppModule } = await import('./src/app.module.js');
          return VelaFactory.create(AppModule, { globalPrefix: '/lazy' });
        },
      };
    
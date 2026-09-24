
      import { VelaFactory } from '@velajs/vela';
      export default {
        async createApp() {
          const { Root } = await import('./lazy-root.mjs');
          return VelaFactory.create(Root);
        },
      };
    
import { Module, VelaFactory } from '@velajs/vela';
import { APP_LOGGER, LoggingModule } from '@velajs/vela/logging';
import {
  Container,
  createExecutionScope,
  buildEntrypointExecutionContext,
} from '@velajs/vela/module-kit';
import { AdminLogBuffer, StudioModule } from '../../src';
import { StudioLoggingModule, StudioTimingInterceptor } from '../../src/logging';

function createApp() {
  const studio = StudioModule.forRoot({ token: 'worker-token', logBufferSize: 4 });
  const logging = LoggingModule.forRoot({ sinks: [] });
  class App {}
  Module({
    imports: [studio, logging, StudioLoggingModule.forRoot({ imports: [studio, logging] })],
  })(App);
  return VelaFactory.create(App);
}
const apps = Promise.all([createApp(), createApp()]);

export default {
  async fetch(request: Request): Promise<Response> {
    const [one, two] = await apps;
    if (new URL(request.url).pathname === '/emit') {
      const logger = one.get(APP_LOGGER);
      logger.createLogger('worker', { password: 'hidden-password', count: 42n }).log('native log');
      const scope = createExecutionScope(new Container());
      class WorkerHandler {}
      await new StudioTimingInterceptor(logger, true).intercept(
        buildEntrypointExecutionContext(
          'queue',
          WorkerHandler,
          'run',
          undefined,
          'worker-owner',
          scope.container,
        ),
        { handle: async () => 'ok' },
      );
      await scope.finish();
      await logger.flush();
      return Response.json({
        isolated: two.get(AdminLogBuffer).size === 0,
        invocationId: scope.lifetime.id,
      });
    }
    return one.getHonoApp().fetch(request);
  },
};

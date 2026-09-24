import { describe, expect, it } from 'vitest';
import {
  Controller,
  Ctx,
  Module,
  Post,
  Req,
  Res,
  VelaFactory,
  type VelaContext,
} from '../index.js';

describe('@Req() and @Ctx()', () => {
  it('injects the platform Request with @Req() and the Hono context with @Ctx()', async () => {
    const seen: Array<{ request: boolean; method: string; sameRaw: boolean; response: boolean }> =
      [];

    @Controller('/echo')
    class EchoController {
      @Post()
      async echo(@Req() request: Request, @Ctx() context: VelaContext, @Res() res: VelaContext) {
        seen.push({
          request: request instanceof Request,
          method: request.method,
          sameRaw: context.req.raw === request,
          response: res === context,
        });
        context.header('x-echo', 'yes');
        return { body: await request.text() };
      }
    }

    @Module({ controllers: [EchoController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const response = await app.getHonoApp().request('/echo', { method: 'POST', body: 'hello' });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-echo')).toBe('yes');
    expect(await response.json()).toEqual({ body: 'hello' });
    expect(seen).toEqual([{ request: true, method: 'POST', sameRaw: true, response: true }]);
  });
});

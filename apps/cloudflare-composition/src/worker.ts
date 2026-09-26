import { Controller, ENV, Get, Inject, Module, Param, Post, Req, Scope } from '@velajs/vela';
import { createCloudflareWorker } from '@velajs/cloudflare';
import { authorized } from './policy';
import { renderPage } from './browser';
import { answer } from './ai';
import { readPrivateItem } from './private-service';
import { renderImage } from './images';

@Controller({ path: '/', scope: Scope.REQUEST })
class CompositionController {
  constructor(@Inject(ENV) private readonly env: Cloudflare.Env) {}

  @Get('/browser/:format')
  browser(@Req() request: Request, @Param('format') format: string) {
    return authorized(request, this.env, () => renderPage(this.env, format, request));
  }

  @Post('/ai/:route')
  ai(@Req() request: Request, @Param('route') route: string) {
    return authorized(request, this.env, (owner) => answer(this.env, owner, route, request));
  }

  @Get('/private-item')
  privateItem(@Req() request: Request) {
    return authorized(request, this.env, () => readPrivateItem(this.env, request));
  }

  @Get('/images/:variant')
  image(@Req() request: Request, @Param('variant') variant: string) {
    return authorized(request, this.env, (owner) => renderImage(this.env, owner, variant, request));
  }
}

/* oxlint-disable typescript/no-extraneous-class -- Vela module declaration. */
@Module({ controllers: [CompositionController] })
export class AppModule {}
/* oxlint-enable typescript/no-extraneous-class */
export default createCloudflareWorker(AppModule);

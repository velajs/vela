import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  VelaFactory,
  Controller,
  Get,
  Module,
  MetadataRegistry,
  ErrorsModule,
  defineErrorCatalog,
} from '../index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

const appCatalog = defineErrorCatalog({
  order_expired: { status: 410, title: 'Order Expired', hint: 'Start a fresh order.' },
});

describe('ErrorsModule.forRoot', () => {
  it('renders a catalog error as its canonical body and reports it through the handler', async () => {
    const report = vi.fn();

    @Controller('/orders')
    class OrdersController {
      @Get('/checkout')
      checkout() {
        throw appCatalog.error('order_expired');
      }
    }

    @Module({
      imports: [ErrorsModule.forRoot({ catalogs: [appCatalog], handler: { report } })],
      controllers: [OrdersController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/orders/checkout');

    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: { code: string; hint?: string } };
    expect(body.error.code).toBe('order_expired');
    expect(body.error.hint).toBe('Start a fresh order.');

    expect(report).toHaveBeenCalledTimes(1);
    const [reportedError, ctx] = report.mock.calls[0] as [{ code: string }, { edge: string }];
    expect(reportedError.code).toBe('order_expired');
    expect(ctx.edge).toBe('http');

    await app.dispose();
  });

  it('rejects bootstrap when two catalogs declare the same error code', async () => {
    const first = defineErrorCatalog({ clash: { status: 409, title: 'First Clash' } });
    const second = defineErrorCatalog({ clash: { status: 410, title: 'Second Clash' } });

    const boot = (async () => {
      @Module({ imports: [ErrorsModule.forRoot({ catalogs: [first, second] })] })
      class AppModule {}
      return VelaFactory.create(AppModule);
    })();

    await expect(boot).rejects.toThrow(/duplicate error code/);
  });

  it('composes only the core catalog when no options are given', async () => {
    @Controller('/orders')
    class OrdersController {
      @Get('/gone')
      gone() {
        throw appCatalog.error('order_expired');
      }
    }

    @Module({
      imports: [ErrorsModule.forRoot()],
      controllers: [OrdersController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/orders/gone');

    // `forRoot()` with no options still provides a working ERROR_CATALOG
    // (CORE_CATALOG); the thrown error renders as its canonical wire body.
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('order_expired');

    await app.dispose();
  });
});

describe('app.useGlobalExceptionHandler', () => {
  it('registers the handler imperatively so errors report through it', async () => {
    const report = vi.fn();

    @Controller('/orders')
    class OrdersController {
      @Get('/checkout')
      checkout() {
        throw appCatalog.error('order_expired');
      }
    }

    @Module({
      imports: [ErrorsModule.forRoot({ catalogs: [appCatalog] })],
      controllers: [OrdersController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    app.useGlobalExceptionHandler({ report });

    const res = await app.getHonoApp().request('/orders/checkout');
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: { code: string; hint?: string } };
    expect(body.error.hint).toBe('Start a fresh order.');
    expect(report).toHaveBeenCalledTimes(1);

    await app.dispose();
  });
});

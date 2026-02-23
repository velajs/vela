import { describe, it, expect, beforeEach } from 'vitest';
import {
  VelaFactory,
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  Module,
  UseFilters,
  UsePipes,
  Catch,
  ParseIntPipe,
  ParseFloatPipe,
  HttpException,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  MetadataRegistry,
} from '../index.js';
import type {
  ExceptionFilter,
  ExecutionContext,
  PipeTransform,
  ArgumentMetadata,
} from '../index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

// =============================================================================
// @Catch type matching
// =============================================================================

describe('@Catch type matching', () => {
  it('should only catch the specified exception type', async () => {
    @Catch(NotFoundException)
    class NotFoundFilter implements ExceptionFilter<NotFoundException> {
      catch(exception: NotFoundException, _context: ExecutionContext) {
        return { caught: 'not-found', message: exception.message };
      }
    }

    @Controller('/catch-test')
    @UseFilters(new NotFoundFilter())
    class CatchTestController {
      @Get('/not-found')
      throwNotFound() {
        throw new NotFoundException('Gone');
      }

      @Get('/forbidden')
      throwForbidden() {
        throw new ForbiddenException('No access');
      }

      @Get('/bad-request')
      throwBadRequest() {
        throw new BadRequestException('Invalid');
      }
    }

    @Module({ controllers: [CatchTestController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    // NotFoundException — caught by NotFoundFilter
    const res1 = await hono.request('/catch-test/not-found');
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual({ caught: 'not-found', message: 'Gone' });

    // ForbiddenException — NOT caught by NotFoundFilter, falls to default handler
    const res2 = await hono.request('/catch-test/forbidden');
    expect(res2.status).toBe(403);
    expect(await res2.json()).toEqual({ statusCode: 403, message: 'No access' });

    // BadRequestException — NOT caught by NotFoundFilter, falls to default handler
    const res3 = await hono.request('/catch-test/bad-request');
    expect(res3.status).toBe(400);
    expect(await res3.json()).toEqual({ statusCode: 400, message: 'Invalid' });
  });

  it('should catch multiple exception types with @Catch(TypeA, TypeB)', async () => {
    @Catch(BadRequestException, NotFoundException)
    class MultiFilter implements ExceptionFilter {
      catch(exception: HttpException, _context: ExecutionContext) {
        return { caught: 'multi', status: exception.getStatus() };
      }
    }

    @Controller('/multi-catch')
    @UseFilters(new MultiFilter())
    class MultiCatchController {
      @Get('/bad')
      bad() {
        throw new BadRequestException();
      }

      @Get('/missing')
      missing() {
        throw new NotFoundException();
      }

      @Get('/forbidden')
      forbidden() {
        throw new ForbiddenException();
      }
    }

    @Module({ controllers: [MultiCatchController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    // BadRequest — caught
    const res1 = await hono.request('/multi-catch/bad');
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual({ caught: 'multi', status: 400 });

    // NotFound — caught
    const res2 = await hono.request('/multi-catch/missing');
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ caught: 'multi', status: 404 });

    // Forbidden — NOT caught
    const res3 = await hono.request('/multi-catch/forbidden');
    expect(res3.status).toBe(403);
  });

  it('should catch all exceptions with @Catch() (no args)', async () => {
    @Catch()
    class CatchAllFilter implements ExceptionFilter {
      catch(exception: unknown, _context: ExecutionContext) {
        const msg =
          exception instanceof Error ? exception.message : 'unknown';
        return { caught: 'all', message: msg };
      }
    }

    @Controller('/catch-all')
    @UseFilters(new CatchAllFilter())
    class CatchAllController {
      @Get('/http')
      httpError() {
        throw new ForbiddenException('nope');
      }

      @Get('/generic')
      genericError() {
        throw new Error('boom');
      }
    }

    @Module({ controllers: [CatchAllController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res1 = await hono.request('/catch-all/http');
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual({ caught: 'all', message: 'nope' });

    const res2 = await hono.request('/catch-all/generic');
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ caught: 'all', message: 'boom' });
  });

  it('should prioritize method-level filters over controller-level', async () => {
    @Catch()
    class ControllerFilter implements ExceptionFilter {
      catch(_exception: unknown, _context: ExecutionContext) {
        return { level: 'controller' };
      }
    }

    @Catch()
    class MethodFilter implements ExceptionFilter {
      catch(_exception: unknown, _context: ExecutionContext) {
        return { level: 'method' };
      }
    }

    @Controller('/filter-priority')
    @UseFilters(new ControllerFilter())
    class PriorityController {
      @Get('/method')
      @UseFilters(new MethodFilter())
      withMethodFilter() {
        throw new Error('test');
      }

      @Get('/controller')
      withControllerOnly() {
        throw new Error('test');
      }
    }

    @Module({ controllers: [PriorityController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    // Method-level filter runs first
    const res1 = await hono.request('/filter-priority/method');
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual({ level: 'method' });

    // Controller-level filter when no method filter
    const res2 = await hono.request('/filter-priority/controller');
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ level: 'controller' });
  });
});

// =============================================================================
// Pipe ordering: param-level after shared pipes
// =============================================================================

describe('Pipe ordering', () => {
  it('should run shared pipes before param-level pipes', async () => {
    const order: string[] = [];

    class SharedPipe implements PipeTransform {
      transform(value: unknown, _metadata: ArgumentMetadata) {
        order.push('shared');
        return value;
      }
    }

    class ParamPipe implements PipeTransform {
      transform(value: unknown, _metadata: ArgumentMetadata) {
        order.push('param');
        return value;
      }
    }

    @Controller('/pipe-order')
    @UsePipes(new SharedPipe())
    class PipeOrderController {
      @Get('/:id')
      handle(@Param('id', new ParamPipe()) id: string) {
        return { id, order: [...order] };
      }
    }

    @Module({ controllers: [PipeOrderController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    order.length = 0;
    const res = await hono.request('/pipe-order/42');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.order).toEqual(['shared', 'param']);
  });

  it('should run global → controller → method → param pipes in order', async () => {
    const order: string[] = [];

    function trackingPipe(name: string): PipeTransform {
      return {
        transform(value: unknown, _metadata: ArgumentMetadata) {
          order.push(name);
          return value;
        },
      };
    }

    @Controller('/full-pipe-order')
    @UsePipes(trackingPipe('controller'))
    class FullPipeOrderController {
      @Get('/:id')
      @UsePipes(trackingPipe('method'))
      handle(@Param('id', trackingPipe('param')) id: string) {
        return { order: [...order] };
      }
    }

    @Module({ controllers: [FullPipeOrderController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    app.useGlobalPipes(trackingPipe('global'));
    const hono = app.getHonoApp();

    order.length = 0;
    const res = await hono.request('/full-pipe-order/42');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.order).toEqual(['global', 'controller', 'method', 'param']);
  });

  it('should chain pipe transformations (output of one is input to next)', async () => {
    class AddPrefixPipe implements PipeTransform<string, string> {
      transform(value: string, _metadata: ArgumentMetadata): string {
        return `prefix_${value}`;
      }
    }

    class UpperCasePipe implements PipeTransform<string, string> {
      transform(value: string, _metadata: ArgumentMetadata): string {
        return value.toUpperCase();
      }
    }

    @Controller('/chain-pipes')
    class ChainPipeController {
      @Get('/:name')
      handle(@Param('name', new AddPrefixPipe(), new UpperCasePipe()) name: string) {
        return { name };
      }
    }

    @Module({ controllers: [ChainPipeController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/chain-pipes/hello');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'PREFIX_HELLO' });
  });

  it('should apply ParseIntPipe at param level while shared pipes also run', async () => {
    const sharedRan: boolean[] = [];

    class TrackingPipe implements PipeTransform {
      transform(value: unknown, _metadata: ArgumentMetadata) {
        sharedRan.push(true);
        return value;
      }
    }

    @Controller('/mixed-pipes')
    @UsePipes(new TrackingPipe())
    class MixedPipeController {
      @Get('/:id')
      handle(@Param('id', ParseIntPipe) id: number) {
        return { id, type: typeof id };
      }
    }

    @Module({ controllers: [MixedPipeController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    sharedRan.length = 0;
    const res = await hono.request('/mixed-pipes/42');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 42, type: 'number' });
    expect(sharedRan.length).toBe(1); // shared pipe ran

    // Invalid int — ParseIntPipe throws 400
    const res2 = await hono.request('/mixed-pipes/abc');
    expect(res2.status).toBe(400);
  });
});

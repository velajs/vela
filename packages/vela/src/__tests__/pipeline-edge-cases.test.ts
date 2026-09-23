import { describe, it, expect } from 'vitest';
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
  ParseUUIDPipe,
  ParseEnumPipe,
  ParseArrayPipe,
  HttpException,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '../index.js';
import type {
  ExceptionFilter,
  ExecutionContext,
  PipeTransform,
  ArgumentMetadata,
} from '../index.js';

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
    expect(await res2.json()).toEqual({ error: { code: 'forbidden', message: 'No access' } });

    // BadRequestException — NOT caught by NotFoundFilter, falls to default handler
    const res3 = await hono.request('/catch-test/bad-request');
    expect(res3.status).toBe(400);
    expect(await res3.json()).toEqual({ error: { code: 'bad_request', message: 'Invalid' } });
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
        const msg = exception instanceof Error ? exception.message : 'unknown';
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

describe('Built-in pipes', () => {
  describe('ParseUUIDPipe', () => {
    it('should pass a valid UUID', async () => {
      @Controller('/uuid')
      class UUIDController {
        @Get('/:id')
        handle(@Param('id', ParseUUIDPipe) id: string) {
          return { id };
        }
      }
      @Module({ controllers: [UUIDController] })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const res = await app.getHonoApp().request('/uuid/550e8400-e29b-41d4-a716-446655440000');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: '550e8400-e29b-41d4-a716-446655440000' });
    });

    it('should reject an invalid UUID', async () => {
      @Controller('/uuid2')
      class UUIDController2 {
        @Get('/:id')
        handle(@Param('id', ParseUUIDPipe) id: string) {
          return { id };
        }
      }
      @Module({ controllers: [UUIDController2] })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const res = await app.getHonoApp().request('/uuid2/not-a-uuid');
      expect(res.status).toBe(400);
    });

    it('should enforce UUID version when specified', async () => {
      const pipe = new ParseUUIDPipe({ version: '4' });
      // Valid v4
      expect(pipe.transform('550e8400-e29b-41d4-a716-446655440000', { type: 'param' })).toBe(
        '550e8400-e29b-41d4-a716-446655440000',
      );
      // Invalid v4 (version digit is 3)
      expect(() =>
        pipe.transform('550e8400-e29b-31d4-a716-446655440000', { type: 'param' }),
      ).toThrow(BadRequestException);
    });
  });

  describe('ParseEnumPipe', () => {
    enum Direction {
      UP = 'UP',
      DOWN = 'DOWN',
    }

    it('should accept valid enum values', async () => {
      @Controller('/enum')
      class EnumController {
        @Get('/:dir')
        handle(@Param('dir', new ParseEnumPipe(Direction)) dir: Direction) {
          return { dir };
        }
      }
      @Module({ controllers: [EnumController] })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const res = await app.getHonoApp().request('/enum/UP');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ dir: 'UP' });
    });

    it('should reject invalid enum values', async () => {
      @Controller('/enum2')
      class EnumController2 {
        @Get('/:dir')
        handle(@Param('dir', new ParseEnumPipe(Direction)) dir: Direction) {
          return { dir };
        }
      }
      @Module({ controllers: [EnumController2] })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const res = await app.getHonoApp().request('/enum2/LEFT');
      expect(res.status).toBe(400);
    });
  });

  describe('ParseArrayPipe', () => {
    it('should split a comma-separated query string into an array', async () => {
      @Controller('/array')
      class ArrayController {
        @Get()
        handle(@Query('ids', new ParseArrayPipe()) ids: string[]) {
          return { ids };
        }
      }
      @Module({ controllers: [ArrayController] })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const res = await app.getHonoApp().request('/array?ids=a,b,c');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ids: ['a', 'b', 'c'] });
    });

    it('should return empty array for missing optional value', () => {
      const pipe = new ParseArrayPipe({ optional: true });
      expect(pipe.transform(undefined, { type: 'query' })).toEqual([]);
    });

    it('should throw for missing required value', () => {
      const pipe = new ParseArrayPipe();
      expect(() => pipe.transform(undefined, { type: 'query' })).toThrow(BadRequestException);
    });

    it('should support custom separator', () => {
      const pipe = new ParseArrayPipe({ separator: '|' });
      expect(pipe.transform('a|b|c', { type: 'query' })).toEqual(['a', 'b', 'c']);
    });
  });
});

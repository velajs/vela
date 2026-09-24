import { describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Module,
  Param,
  Post,
  VelaFactory,
  type VelaApplication,
} from '../index';
import { WebSocketModule } from '../websocket/index';
import {
  COMMIT_CURSOR_HEADER,
  COMMIT_EPOCH_HEADER,
  LiveInvalidates,
  LiveModule,
  type CommitStamp,
  type InvalidationCommand,
  type LiveDriver,
} from '../live/index';

/** Records every invalidation and stamps it with the next cursor. */
class RecordingDriver implements LiveDriver {
  readonly kind = 'recording';
  readonly commands: InvalidationCommand[] = [];
  bind(): void {}
  dispatch(cmd: InvalidationCommand): CommitStamp {
    this.commands.push(cmd);
    return { cursor: this.commands.length, epoch: 'epoch-1' };
  }
}

@Controller('/todos')
class TodosController {
  @Post()
  @LiveInvalidates(['todos'])
  create(): { id: string } {
    return { id: 't1' };
  }

  @Delete('/:id')
  @LiveInvalidates((result: { removed: boolean }) => (result.removed ? ['todos'] : []))
  async remove(@Param('id') id: string): Promise<{ removed: boolean }> {
    return { removed: id === 't1' };
  }

  @Post('/rejected')
  @LiveInvalidates(['todos'])
  rejected(): { id: string } {
    throw new BadRequestException('rejected');
  }

  @Get('/raw')
  @LiveInvalidates(['todos'], { room: 'org-1' })
  raw(): Response {
    return new Response('raw', { headers: { 'x-raw': '1' } });
  }

  @Post('/rooms/:room')
  @LiveInvalidates(['todos'], {
    room: (_result, context) => context.getRequest().url.split('/').at(-1),
  })
  roomed(): { ok: boolean } {
    return { ok: true };
  }
}

async function makeApp(driver: RecordingDriver): Promise<VelaApplication> {
  @Module({
    imports: [WebSocketModule.forRoot(), LiveModule.forRoot({ driver: () => driver })],
    controllers: [TodosController],
  })
  class AppModule {}
  return VelaFactory.create(AppModule);
}

function request(method: string, path: string): Request {
  return new Request(`http://app.test${path}`, { method });
}

describe('@LiveInvalidates', () => {
  it('invalidates the declared tags after the handler and stamps the commit on its response', async () => {
    const driver = new RecordingDriver();
    const app = await makeApp(driver);
    try {
      const response = await app.fetch(request('POST', '/todos'));
      expect(await response.json()).toEqual({ id: 't1' });
      expect(driver.commands).toEqual([{ tags: ['todos'] }]);
      expect(response.headers.get(COMMIT_CURSOR_HEADER)).toBe('1');
      expect(response.headers.get(COMMIT_EPOCH_HEADER)).toBe('epoch-1');
    } finally {
      await app.close();
    }
  });

  it('derives tags from the result and skips an invalidation that names none', async () => {
    const driver = new RecordingDriver();
    const app = await makeApp(driver);
    try {
      const missing = await app.fetch(request('DELETE', '/todos/t2'));
      expect(await missing.json()).toEqual({ removed: false });
      expect(missing.headers.get(COMMIT_CURSOR_HEADER)).toBeNull();
      expect(driver.commands).toEqual([]);

      const removed = await app.fetch(request('DELETE', '/todos/t1'));
      expect(await removed.json()).toEqual({ removed: true });
      expect(removed.headers.get(COMMIT_CURSOR_HEADER)).toBe('1');
      expect(driver.commands).toEqual([{ tags: ['todos'] }]);
    } finally {
      await app.close();
    }
  });

  it('invalidates nothing when the handler fails', async () => {
    const driver = new RecordingDriver();
    const app = await makeApp(driver);
    try {
      const response = await app.fetch(request('POST', '/todos/rejected'));
      expect(response.status).toBe(400);
      expect(response.headers.get(COMMIT_CURSOR_HEADER)).toBeNull();
      expect(driver.commands).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('targets a room and stamps a Response the handler returns itself', async () => {
    const driver = new RecordingDriver();
    const app = await makeApp(driver);
    try {
      const raw = await app.fetch(request('GET', '/todos/raw'));
      expect(await raw.text()).toBe('raw');
      expect(raw.headers.get('x-raw')).toBe('1');
      expect(raw.headers.get(COMMIT_CURSOR_HEADER)).toBe('1');
      expect(raw.headers.get(COMMIT_EPOCH_HEADER)).toBe('epoch-1');

      await app.fetch(request('POST', '/todos/rooms/org-2'));
      expect(driver.commands).toEqual([
        { tags: ['todos'], room: 'org-1' },
        { tags: ['todos'], room: 'org-2' },
      ]);
    } finally {
      await app.close();
    }
  });

  it('fails before the handler runs when the declaring module cannot reach LiveModule', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    let created = 0;
    @Controller('/orphan')
    class OrphanController {
      @Post()
      @LiveInvalidates(['todos'])
      create(): { ok: boolean } {
        created++;
        return { ok: true };
      }
    }
    @Module({ controllers: [OrphanController] })
    class OrphanModule {}

    const app = await VelaFactory.create(OrphanModule);
    try {
      const response = await app.fetch(request('POST', '/orphan'));
      expect(response.status).toBe(500);
      expect(created).toBe(0);
      expect(errors.mock.calls.flat().map(String).join('\n')).toMatch(
        /@LiveInvalidates on OrphanController needs LiveInvalidation: import LiveModule\.forRoot\(\)/,
      );
    } finally {
      errors.mockRestore();
      await app.close();
    }
  });
});

import { sessionFixture } from './fixtures';
import {
  Controller,
  Endpoint,
  Get,
  MetadataRegistry,
  Module,
  UseGuards,
  VelaFactory,
  defineEndpoint,
} from '@velajs/vela';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthGuard, BetterAuthModule, CurrentSession, CurrentUser } from '../index';
import type { BetterAuthInstance, Session, User } from '../better-auth.types';

interface ProfileInput {
  query: { view?: 'summary' | 'full' };
}

interface ProfileOutput {
  view: string;
  userId: string;
  sessionId: string;
}

// Structural parsers keep the fixture free of a schema-library dependency.
const profile = defineEndpoint({
  input: {
    parse(value: unknown): ProfileInput {
      const query =
        typeof value === 'object' && value !== null && 'query' in value ? value.query : undefined;
      const view =
        typeof query === 'object' && query !== null && 'view' in query ? query.view : undefined;
      if (view !== undefined && view !== 'summary' && view !== 'full') {
        throw { issues: [{ message: 'Invalid view', path: ['query', 'view'] }] };
      }
      return { query: view === undefined ? {} : { view } };
    },
    toJSONSchema: () => ({
      type: 'object',
      properties: {
        query: {
          type: 'object',
          properties: { view: { type: 'string', enum: ['summary', 'full'] } },
        },
      },
    }),
  },
  output: {
    parse(value: unknown): ProfileOutput {
      if (
        typeof value !== 'object' ||
        value === null ||
        !('view' in value) ||
        !('userId' in value) ||
        !('sessionId' in value) ||
        typeof value.view !== 'string' ||
        typeof value.userId !== 'string' ||
        typeof value.sessionId !== 'string'
      ) {
        throw new TypeError('Invalid profile output');
      }
      return { view: value.view, userId: value.userId, sessionId: value.sessionId };
    },
    toJSONSchema: () => ({ type: 'object' }),
  },
});

function mockAuth(session: ReturnType<typeof sessionFixture> | null) {
  return {
    api: { getSession: vi.fn().mockResolvedValue(session) },
    handler: vi.fn().mockResolvedValue(new Response('ok')),
  } satisfies BetterAuthInstance;
}

describe('identity decorators on @Endpoint handlers', () => {
  beforeEach(() => MetadataRegistry.clear());
  afterEach(() => MetadataRegistry.clear());

  async function createApp(session: ReturnType<typeof sessionFixture> | null) {
    const handled = vi.fn();

    @Controller('/profile')
    @UseGuards(AuthGuard)
    class ProfileController {
      @Get()
      @Endpoint(profile)
      read(
        input: ProfileInput,
        @CurrentUser() user: User | undefined,
        @CurrentSession() activeSession: Session | undefined,
      ) {
        handled();
        return {
          view: input.query.view ?? 'summary',
          userId: user?.id ?? 'anonymous',
          sessionId: activeSession?.id ?? 'none',
        };
      }
    }

    @Module({
      imports: [BetterAuthModule.forRoot({ auth: mockAuth(session) })],
      controllers: [ProfileController],
    })
    class AppModule {}

    return { app: await VelaFactory.create(AppModule), handled };
  }

  it('resolves @CurrentUser() and @CurrentSession() after the validated input', async () => {
    const { app, handled } = await createApp(sessionFixture('u-7'));
    const response = await app.getHonoApp().request('/profile?view=full');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      view: 'full',
      userId: 'u-7',
      sessionId: 'session-u-7',
    });
    expect(handled).toHaveBeenCalledTimes(1);

    const invalid = await app.getHonoApp().request('/profile?view=everything');
    expect(invalid.status).toBe(400);
    expect(handled).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('still rejects unauthenticated requests in the guard', async () => {
    const { app, handled } = await createApp(null);
    const response = await app.getHonoApp().request('/profile');
    expect(response.status).toBe(401);
    expect(handled).not.toHaveBeenCalled();
    await app.close();
  });
});

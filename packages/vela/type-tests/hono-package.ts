import type { ExecutionContext, RequestContext, VelaApplication } from '@velajs/vela';

// These import only the emitted public package, so declaration generation
// cannot silently weaken the raw Hono boundary back to any.
export function verifyHonoPackageBoundary(
  app: VelaApplication,
  execution: ExecutionContext,
  request: RequestContext,
): void {
  // @ts-expect-error Unvalidated Hono variables cannot claim a number.
  const count: number = execution.getContext().get('count');
  // @ts-expect-error Workers binding types must come from the typed environment token.
  request.hono.env.DB.prepare('select 1');
  app.getHonoApp().get('/raw', (context) => {
    // @ts-expect-error App-level Hono callbacks also keep raw values unknown.
    const session: { userId: string } = context.get('session');
    void session;
    return context.text('ok');
  });
  void count;
}

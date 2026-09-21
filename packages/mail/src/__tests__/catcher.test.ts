import { describe, expect, it } from 'vitest';
import { createMailCatcher } from '../transports/catcher';
import type { BuiltMessage } from '../types';

function built(subject: string, to = 'a@b.com'): BuiltMessage {
  return {
    from: { email: 'sender@example.com' },
    to: [{ email: to }],
    cc: [],
    bcc: [],
    subject,
    text: 'body',
    headers: {},
    envelope: { from: 'sender@example.com', to: [to] },
  };
}

describe('createMailCatcher', () => {
  it('captures each delivered message with an id and timestamp', async () => {
    const catcher = createMailCatcher();
    const before = Date.now();
    const result = await catcher.deliver(built('One'));

    expect(result.provider).toBe('catcher');
    expect(typeof result.id).toBe('string');

    const messages = catcher.messages();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.subject).toBe('One');
    expect(messages[0]!.id).toBe(result.id);
    expect(messages[0]!.capturedAt).toBeGreaterThanOrEqual(before);
  });

  it('preserves delivery order and clears', async () => {
    const catcher = createMailCatcher();
    await catcher.deliver(built('One'));
    await catcher.deliver(built('Two'));
    expect(catcher.messages().map((m) => m.subject)).toEqual(['One', 'Two']);

    catcher.clear();
    expect(catcher.messages()).toEqual([]);
  });

  it('returns a defensive copy from messages()', async () => {
    const catcher = createMailCatcher();
    await catcher.deliver(built('One'));
    const snapshot = catcher.messages();
    snapshot.length = 0;
    expect(catcher.messages()).toHaveLength(1);
  });

  it('waitFor resolves when a matching message arrives', async () => {
    const catcher = createMailCatcher();
    const pending = catcher.waitFor((m) => m.subject === 'Delayed', { pollMs: 1, timeoutMs: 500 });
    await catcher.deliver(built('Delayed'));
    const hit = await pending;
    expect(hit.subject).toBe('Delayed');
  });

  it('waitFor rejects on timeout', async () => {
    const catcher = createMailCatcher();
    await expect(
      catcher.waitFor((m) => m.subject === 'never', { pollMs: 1, timeoutMs: 20 }),
    ).rejects.toThrow(/timed out/);
  });

  describe('handler()', () => {
    it('serves a JSON list by default', async () => {
      const catcher = createMailCatcher();
      await catcher.deliver(built('One'));
      const res = catcher.handler()(new Request('http://catcher/'));
      expect(res.headers.get('content-type')).toContain('application/json');
      const list = (await res.json()) as Array<{ subject: string }>;
      expect(list.map((m) => m.subject)).toEqual(['One']);
    });

    it('serves an HTML inbox with ?format=html', async () => {
      const catcher = createMailCatcher();
      await catcher.deliver(built('Report'));
      const res = catcher.handler()(new Request('http://catcher/?format=html'));
      expect(res.headers.get('content-type')).toContain('text/html');
      const html = await res.text();
      expect(html).toContain('Report');
      expect(html).toContain('Mail catcher (1)');
    });

    it('DELETE clears captured messages', async () => {
      const catcher = createMailCatcher();
      await catcher.deliver(built('One'));
      const res = catcher.handler()(new Request('http://catcher/', { method: 'DELETE' }));
      expect(res.status).toBe(204);
      expect(catcher.messages()).toEqual([]);
    });

    it('escapes HTML in captured content', async () => {
      const catcher = createMailCatcher();
      await catcher.deliver({ ...built('<script>alert(1)</script>'), html: '<img src=x>' });
      const res = catcher.handler()(new Request('http://catcher/?format=html'));
      const html = await res.text();
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;');
    });
  });
});

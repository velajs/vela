import { describe, expect, it, vi } from 'vitest';
import { buildMessage } from '../build';
import { MailError } from '../mail.error';
import type { RenderInput, RenderSeam } from '../types';

const FROM = 'sender@example.com';

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof MailError) return err.code;
    throw err;
  }
  throw new Error('expected a MailError');
}

describe('buildMessage', () => {
  it('builds a minimal message and normalizes addresses', async () => {
    const built = await buildMessage(
      { to: 'a@b.com', subject: 'Hi', text: 'body' },
      { from: FROM },
    );
    expect(built.from).toEqual({ email: FROM });
    expect(built.to).toEqual([{ email: 'a@b.com' }]);
    expect(built.cc).toEqual([]);
    expect(built.bcc).toEqual([]);
    expect(built.text).toBe('body');
    expect(built.envelope).toEqual({ from: FROM, to: ['a@b.com'] });
  });

  it('falls back to the mailer default from', async () => {
    const built = await buildMessage({ to: 'a@b.com', subject: 'Hi', text: 'x' }, { from: FROM });
    expect(built.from.email).toBe(FROM);
  });

  it('prefers a per-message from over the default', async () => {
    const built = await buildMessage(
      { from: 'other@example.com', to: 'a@b.com', subject: 'Hi', text: 'x' },
      { from: FROM },
    );
    expect(built.from.email).toBe('other@example.com');
  });

  it('invokes the render seam ONLY for a template message', async () => {
    const render = vi.fn<RenderSeam>(() => ({ html: '<b>rendered</b>' }));
    await buildMessage(
      { to: 'a@b.com', subject: 'Hi', html: '<i>explicit</i>' },
      {
        from: FROM,
        render,
      },
    );
    expect(render).not.toHaveBeenCalled();

    const built = await buildMessage(
      { to: 'a@b.com', subject: 'Hi', template: { k: 'v' } },
      {
        from: FROM,
        render,
      },
    );
    expect(render).toHaveBeenCalledTimes(1);
    expect(built.html).toBe('<b>rendered</b>');
  });

  it('lets explicit html/text win over a rendered result', async () => {
    const render: RenderSeam = () => ({ html: '<b>rendered</b>', text: 'rendered-text' });
    const built = await buildMessage(
      { to: 'a@b.com', subject: 'Hi', html: '<i>explicit</i>', template: {} },
      { from: FROM, render },
    );
    expect(built.html).toBe('<i>explicit</i>');
    expect(built.text).toBe('rendered-text');
  });

  it('throws invalid_message for a template with no render seam', async () => {
    expect(
      await codeOf(() =>
        buildMessage({ to: 'a@b.com', subject: 'Hi', template: {} }, { from: FROM }),
      ),
    ).toBe('invalid_message');
  });

  it('wraps a render seam throw as render_failed', async () => {
    const render: RenderSeam = () => {
      throw new Error('boom');
    };
    expect(
      await codeOf(() =>
        buildMessage({ to: 'a@b.com', subject: 'Hi', template: {} }, { from: FROM, render }),
      ),
    ).toBe('render_failed');
  });

  it('throws invalid_message for an empty recipient list', async () => {
    expect(
      await codeOf(() => buildMessage({ to: [], subject: 'Hi', text: 'x' }, { from: FROM })),
    ).toBe('invalid_message');
  });

  it('throws invalid_message for a body-less message', async () => {
    expect(await codeOf(() => buildMessage({ to: 'a@b.com', subject: 'Hi' }, { from: FROM }))).toBe(
      'invalid_message',
    );
  });

  it('derives envelope.to from the unique union of to+cc+bcc', async () => {
    const built = await buildMessage(
      {
        to: ['a@b.com', 'a@b.com'],
        cc: 'c@d.com',
        bcc: ['a@b.com', 'e@f.com'],
        subject: 'Hi',
        text: 'x',
      },
      { from: FROM },
    );
    expect(built.envelope.to).toEqual(['a@b.com', 'c@d.com', 'e@f.com']);
  });

  it('guards custom headers during build', async () => {
    const built = await buildMessage(
      { to: 'a@b.com', subject: 'Hi', text: 'x', headers: { 'X-Tag': 'value' } },
      { from: FROM },
    );
    expect(built.headers).toEqual({ 'X-Tag': 'value' });
  });

  it.each([
    'From',
    'To',
    'Bcc',
    'Subject',
    'Content-Type',
    'Authentication-Results',
    'DKIM-Signature',
    'ARC-Seal',
    'Resent-To',
  ])('rejects reserved custom header %s', async (name) => {
    expect(
      await codeOf(() =>
        buildMessage(
          { to: 'a@b.com', subject: 'Hi', text: 'x', headers: { [name]: 'forged' } },
          { from: FROM },
        ),
      ),
    ).toBe('invalid_header');
  });

  it('caps recipients, custom headers, body bytes, header bytes, and total bytes', async () => {
    expect(
      await codeOf(() =>
        buildMessage(
          { to: ['a@b.com', 'c@d.com'], subject: 'Hi', text: 'x' },
          { from: FROM, limits: { maxRecipients: 1 } },
        ),
      ),
    ).toBe('invalid_message');
    expect(
      await codeOf(() =>
        buildMessage(
          { to: 'a@b.com', subject: 'Hi', text: 'x', headers: { 'X-A': '1', 'X-B': '2' } },
          { from: FROM, limits: { maxHeaders: 1 } },
        ),
      ),
    ).toBe('invalid_header');
    expect(
      await codeOf(() =>
        buildMessage(
          { to: 'a@b.com', subject: 'Hi', text: 'éé' },
          { from: FROM, limits: { maxBodyBytes: 3 } },
        ),
      ),
    ).toBe('invalid_message');
    expect(
      await codeOf(() =>
        buildMessage(
          { to: 'a@b.com', subject: '12345', text: 'x' },
          { from: FROM, limits: { maxHeaderBytes: 5 } },
        ),
      ),
    ).toBe('invalid_header');
    expect(
      await codeOf(() =>
        buildMessage(
          { to: 'a@b.com', subject: 'Hi', text: '12345' },
          { from: FROM, limits: { maxMessageBytes: 8 } },
        ),
      ),
    ).toBe('invalid_message');
  });
});

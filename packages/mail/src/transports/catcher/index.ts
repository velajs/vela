import type { BuiltMessage, DeliveryResult, MailTransport } from '../../types';

/** A message captured by the dev catcher, with an id and capture timestamp. */
export interface CapturedMessage extends BuiltMessage {
  id: string;
  capturedAt: number;
}

export interface WaitForOptions {
  /** Give up after this many ms (default 1000). */
  timeoutMs?: number;
  /** Poll interval in ms (default 10). */
  pollMs?: number;
}

/** An in-memory dev transport that captures messages for inspection/assertions. */
export interface MailCatcher extends MailTransport {
  /** Captured messages in delivery order. */
  messages(): CapturedMessage[];
  /** Discard all captured messages. */
  clear(): void;
  /** Resolve with the first captured message matching `pred`; reject on timeout. */
  waitFor(
    pred: (m: CapturedMessage) => boolean,
    options?: WaitForOptions,
  ): Promise<CapturedMessage>;
  /** A framework-free `Request => Response` dev viewer (JSON list, HTML inbox, DELETE clears). */
  handler(): (req: Request) => Response;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderInboxHtml(messages: CapturedMessage[]): string {
  const rows = messages
    .map((m) => {
      const to = m.to.map((a) => escapeHtml(a.email)).join(', ');
      const body = escapeHtml(m.html ?? m.text ?? '');
      return `<article><h2>${escapeHtml(m.subject)}</h2><p><strong>To:</strong> ${to}</p><pre>${body}</pre></article>`;
    })
    .join('\n');
  const empty = '<p><em>No captured messages.</em></p>';
  return `<!doctype html><meta charset="utf-8"><title>Mail catcher</title><main><h1>Mail catcher (${messages.length})</h1>${messages.length === 0 ? empty : rows}</main>`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create an in-memory mail catcher. `deliver` captures each built message with a
 * generated id and timestamp; `handler()` returns a self-contained dev viewer.
 * Pure Web APIs (crypto, Request, Response) — no framework, no node.
 */
export function createMailCatcher(): MailCatcher {
  const captured: CapturedMessage[] = [];

  return {
    async deliver(built: BuiltMessage): Promise<DeliveryResult> {
      const message: CapturedMessage = {
        ...built,
        id: crypto.randomUUID(),
        capturedAt: Date.now(),
      };
      captured.push(message);
      return { id: message.id, provider: 'catcher' };
    },

    messages(): CapturedMessage[] {
      return [...captured];
    },

    clear(): void {
      captured.length = 0;
    },

    async waitFor(
      pred: (m: CapturedMessage) => boolean,
      options: WaitForOptions = {},
    ): Promise<CapturedMessage> {
      const timeoutMs = options.timeoutMs ?? 1000;
      const pollMs = options.pollMs ?? 10;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = captured.find(pred);
        if (hit) return hit;
        if (Date.now() >= deadline) {
          throw new Error(
            `@velajs/mail: waitFor timed out after ${timeoutMs}ms with ${captured.length} captured message(s)`,
          );
        }
        await delay(pollMs);
      }
    },

    handler(): (req: Request) => Response {
      return (req: Request): Response => {
        if (req.method === 'DELETE') {
          captured.length = 0;
          return new Response(null, { status: 204 });
        }
        const url = new URL(req.url);
        if (url.searchParams.get('format') === 'html') {
          return new Response(renderInboxHtml([...captured]), {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }
        return new Response(JSON.stringify([...captured]), {
          headers: { 'content-type': 'application/json' },
        });
      };
    },
  };
}

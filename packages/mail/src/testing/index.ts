// @velajs/mail/testing — framework-free assertion helpers over the dev catcher.
//
//   import { createMailCatcher } from '@velajs/mail/transports/catcher';
//   import { assertSent, extractLink } from '@velajs/mail/testing';
//
//   const catcher = createMailCatcher();
//   await new MailService(catcher, ...).send({ to: 'a@b.c', subject: 'Hi', text: 'yo' });
//   const msg = assertSent(catcher, { to: 'a@b.c', subjectMatch: 'Hi' });
//
// The helpers throw a diagnostic plain `Error` on failure (no vitest/`expect`
// dependency) and drive the catcher's public surface, so guard behavior and
// capture stay honest.

import { createMailCatcher } from '../transports/catcher';
import type { CapturedMessage, MailCatcher, WaitForOptions } from '../transports/catcher';

export { createMailCatcher };
export type { CapturedMessage, MailCatcher, WaitForOptions };

/** A read surface satisfied by {@link MailCatcher} — anything with `messages()`. */
export interface CaptureSource {
  messages(): CapturedMessage[];
  waitFor(
    pred: (m: CapturedMessage) => boolean,
    options?: WaitForOptions,
  ): Promise<CapturedMessage>;
}

export interface MatchCriteria {
  /** Match a recipient (to/cc/bcc) whose email equals this value. */
  to?: string;
  /** Match a subject that contains this substring. */
  subjectMatch?: string;
}

function recipients(m: CapturedMessage): string[] {
  return [...m.to, ...m.cc, ...m.bcc].map((a) => a.email);
}

function matches(m: CapturedMessage, criteria: MatchCriteria): boolean {
  if (criteria.to !== undefined && !recipients(m).includes(criteria.to)) return false;
  if (criteria.subjectMatch !== undefined && !m.subject.includes(criteria.subjectMatch)) {
    return false;
  }
  return true;
}

function describe(messages: CapturedMessage[]): string {
  if (messages.length === 0) return '(none)';
  return messages
    .map((m) => `{ to: ${recipients(m).join('|') || '?'}, subject: ${JSON.stringify(m.subject)} }`)
    .join(', ');
}

/** Assert a message matching `criteria` was captured; returns it, or throws. */
export function assertSent(source: CaptureSource, criteria: MatchCriteria): CapturedMessage {
  const all = source.messages();
  const hit = all.find((m) => matches(m, criteria));
  if (!hit) {
    throw new Error(
      `assertSent: no captured message matched ${JSON.stringify(criteria)}. Captured: ${describe(all)}`,
    );
  }
  return hit;
}

/** Assert NO captured message matches `criteria`; throws with the offender otherwise. */
export function assertNotSent(source: CaptureSource, criteria: MatchCriteria): void {
  const hit = source.messages().find((m) => matches(m, criteria));
  if (hit) {
    throw new Error(
      `assertNotSent: a captured message matched ${JSON.stringify(criteria)} (subject ${JSON.stringify(hit.subject)})`,
    );
  }
}

/** Assert exactly `expected` messages were captured. */
export function assertCount(source: CaptureSource, expected: number): void {
  const all = source.messages();
  if (all.length !== expected) {
    throw new Error(
      `assertCount: expected ${expected} captured message(s), found ${all.length}: ${describe(all)}`,
    );
  }
}

/** The most recently captured message; throws if none. */
export function lastMessage(source: CaptureSource): CapturedMessage {
  const all = source.messages();
  const last = all.at(-1);
  if (!last) throw new Error('lastMessage: no messages have been captured');
  return last;
}

/**
 * Extract the first `https?://…` link from a message (HTML body first, then
 * text), decoding `&amp;`. Throws if no link (or no matching link) is found.
 */
export function extractLink(m: CapturedMessage, options: { match?: string } = {}): string {
  const sources = [m.html, m.text];
  const linkRe = /https?:\/\/[^\s"'<>)]+/g;
  for (const body of sources) {
    if (body === undefined) continue;
    for (const raw of body.match(linkRe) ?? []) {
      const link = raw.replace(/&amp;/g, '&');
      if (options.match === undefined || link.includes(options.match)) return link;
    }
  }
  throw new Error(
    `extractLink: no ${options.match === undefined ? '' : `"${options.match}" `}link found in the message body`,
  );
}

/** Await a message matching `criteria` (thin wrapper over the catcher's `waitFor`). */
export function waitForMail(
  source: CaptureSource,
  criteria: MatchCriteria,
  options?: WaitForOptions,
): Promise<CapturedMessage> {
  return source.waitFor((m) => matches(m, criteria), options);
}

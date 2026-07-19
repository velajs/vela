import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AdminErrorBody } from '@velajs/studio-protocol';
import type { WireErrorObject } from '@velajs/errors';
import { AdminAuditLog } from '../src/audit/audit-log';
import { AdminLogBuffer } from '../src/logs/log-buffer';
import type { AdminAuditEntry } from '@velajs/studio-protocol';

// ---- drift guard: AdminErrorBody (minus Studio enrichment) === WireErrorObject
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type SharedAdminFields = Omit<AdminErrorBody, 'title' | 'status'>;
// Both directions: a compile error here is the drift alarm.
type _DriftGuard = Expect<Equal<SharedAdminFields, WireErrorObject>>;

describe('AdminErrorBody / WireErrorObject drift guard', () => {
  it('shared fields match structurally (compile-time assertion holds)', () => {
    const driftProof: _DriftGuard = true;
    expect(driftProof).toBe(true);
  });
});

describe('openness audit — no deep vela imports', () => {
  it('every src file imports vela only via the public @velajs/vela barrel', () => {
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
    const files = readdirSync(srcDir, { recursive: true, encoding: 'utf8' }).filter((f) =>
      f.endsWith('.ts'),
    );
    const offenders: string[] = [];
    const importRe = /(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]/g;
    for (const rel of files) {
      const content = readFileSync(join(srcDir, rel), 'utf8');
      for (const match of content.matchAll(importRe)) {
        const spec = match[1] ?? '';
        // Allowed: the bare public barrel. Disallowed: any deep subpath or a
        // relative climb into a sibling vela source tree.
        if (spec === '@velajs/vela') continue;
        if (spec.startsWith('@velajs/vela/')) offenders.push(`${rel}: ${spec}`);
        if (/(^|\/)vela\/src\//.test(spec)) offenders.push(`${rel}: ${spec}`);
        if (spec.startsWith('node:')) offenders.push(`${rel}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every src file is edge-safe (no node builtins / process / Buffer / require API)', () => {
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
    const files = readdirSync(srcDir, { recursive: true, encoding: 'utf8' }).filter((f) =>
      f.endsWith('.ts'),
    );
    // Match real API usage, not the word appearing in prose/JSDoc.
    const forbidden: Array<[RegExp, string]> = [
      [/\bnew\s+Buffer\b/, 'Buffer'],
      [/\bBuffer\s*\.\s*(from|alloc|allocUnsafe|concat|isBuffer)\b/, 'Buffer'],
      [
        /\bprocess\s*\.\s*(env|argv|cwd|platform|exit|version|versions|nextTick|hrtime|stdout|stderr)\b/,
        'process',
      ],
      [/\brequire\s*\(/, 'require()'],
    ];
    const offenders: string[] = [];
    for (const rel of files) {
      const content = readFileSync(join(srcDir, rel), 'utf8');
      for (const [re, label] of forbidden) {
        if (re.test(content)) offenders.push(`${rel}: ${label}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

const entry = (op: string): AdminAuditEntry => ({
  ts: Date.now(),
  op,
  mode: 'read',
  subject: 'master',
  status: 200,
  ms: 1,
  ip: null,
});

describe('AdminAuditLog', () => {
  it('rings at capacity (oldest evicted)', () => {
    const log = new AdminAuditLog(2);
    log.record(entry('a'));
    log.record(entry('b'));
    log.record(entry('c'));
    expect(log.size).toBe(2);
    expect(log.tail().map((e) => e.op)).toEqual(['c', 'b']);
  });

  it('tail honors limit and returns most-recent first', () => {
    const log = new AdminAuditLog(10);
    for (const op of ['a', 'b', 'c']) log.record(entry(op));
    expect(log.tail(2).map((e) => e.op)).toEqual(['c', 'b']);
  });

  it('mirrors to a sink best-effort and never throws when the sink throws', () => {
    const seen: string[] = [];
    const log = new AdminAuditLog(10, {
      write(e) {
        seen.push(e.op);
        throw new Error('sink boom');
      },
    });
    expect(() => log.record(entry('x'))).not.toThrow();
    expect(seen).toEqual(['x']);
  });
});

describe('AdminLogBuffer', () => {
  it('rings at capacity and filters by level', () => {
    const buf = new AdminLogBuffer(3);
    buf.record({ ts: 1, level: 'info', msg: 'a' });
    buf.record({ ts: 2, level: 'error', msg: 'b' });
    buf.record({ ts: 3, level: 'info', msg: 'c' });
    buf.record({ ts: 4, level: 'error', msg: 'd' });
    expect(buf.size).toBe(3);
    expect(buf.tail({ level: 'error' }).map((e) => e.msg)).toEqual(['d', 'b']);
    expect(buf.tail({ limit: 1 }).map((e) => e.msg)).toEqual(['d']);
  });
});

/**
 * Golden wire fixtures — the drift tripwire. The server suite (@velajs/vela)
 * and the client suite (@velajs/client) both run these through
 * `runProtocolConformance`, so an encoding change on either side fails a test
 * instead of surfacing as a production incompatibility.
 *
 * `wire` strings are byte-exact: they pin the canonical key order of
 * `encodeLiveEnvelope`. Do not reformat them.
 */

import type { LiveFrame, RowOp } from './frames';

export interface FrameFixture {
  name: string;
  frame: LiveFrame;
  /** Exact canonical envelope bytes: `encodeLiveEnvelope(frame)` must equal this. */
  wire: string;
}

export const FRAME_FIXTURES: FrameFixture[] = [
  {
    name: 'sub (full)',
    frame: {
      t: 'sub',
      sub: 's1',
      query: 'todos.list',
      args: { listId: 'l1' },
      sinceCursor: 42,
      sinceEpoch: 'e-1',
      key: 'id',
      v: 2,
    },
    wire: '{"event":"$live","data":{"t":"sub","sub":"s1","query":"todos.list","args":{"listId":"l1"},"sinceCursor":42,"sinceEpoch":"e-1","key":"id","v":2}}',
  },
  {
    name: 'sub (minimal)',
    frame: { t: 'sub', sub: 's2', query: 'todos.all', v: 2 },
    wire: '{"event":"$live","data":{"t":"sub","sub":"s2","query":"todos.all","v":2}}',
  },
  {
    name: 'unsub',
    frame: { t: 'unsub', sub: 's1' },
    wire: '{"event":"$live","data":{"t":"unsub","sub":"s1"}}',
  },
  {
    name: 'presence',
    frame: { t: 'presence', room: 'r1', meta: { name: 'kauan' } },
    wire: '{"event":"$live","data":{"t":"presence","room":"r1","meta":{"name":"kauan"}}}',
  },
  {
    name: 'ack',
    frame: { t: 'ack', sub: 's1' },
    wire: '{"event":"$live","data":{"t":"ack","sub":"s1"}}',
  },
  {
    name: 'data',
    frame: { t: 'data', sub: 's1', snapshot: [{ id: 'a', text: 'hi' }], cursor: 7, epoch: 'e-1' },
    wire: '{"event":"$live","data":{"t":"data","sub":"s1","snapshot":[{"id":"a","text":"hi"}],"cursor":7,"epoch":"e-1"}}',
  },
  {
    name: 'data (cold, no cursor)',
    frame: { t: 'data', sub: 's1', snapshot: null },
    wire: '{"event":"$live","data":{"t":"data","sub":"s1","snapshot":null}}',
  },
  {
    name: 'delta',
    frame: {
      t: 'delta',
      sub: 's1',
      ops: [
        { op: 'delete', key: 'a' },
        { op: 'insert', key: 'b', row: { id: 'b' }, before: null },
        { op: 'update', key: 'c', row: { id: 'c', n: 2 } },
      ],
      cursor: 8,
      epoch: 'e-1',
    },
    wire: '{"event":"$live","data":{"t":"delta","sub":"s1","ops":[{"op":"delete","key":"a"},{"op":"insert","key":"b","row":{"id":"b"},"before":null},{"op":"update","key":"c","row":{"id":"c","n":2}}],"cursor":8,"epoch":"e-1"}}',
  },
  {
    name: 'settled',
    frame: { t: 'settled', sub: 's1', cursor: 9, epoch: 'e-1' },
    wire: '{"event":"$live","data":{"t":"settled","sub":"s1","cursor":9,"epoch":"e-1"}}',
  },
  {
    name: 'resume',
    frame: { t: 'resume', sub: 's1', cursor: 42, epoch: 'e-1' },
    wire: '{"event":"$live","data":{"t":"resume","sub":"s1","cursor":42,"epoch":"e-1"}}',
  },
  {
    name: 'error (subscription)',
    frame: { t: 'error', sub: 's1', code: 'forbidden', message: 'nope', fatal: true },
    wire: '{"event":"$live","data":{"t":"error","sub":"s1","code":"forbidden","message":"nope","fatal":true}}',
  },
  {
    name: 'error (connection)',
    frame: { t: 'error', code: 'unsupported_protocol', message: 'v2 required', fatal: true },
    wire: '{"event":"$live","data":{"t":"error","code":"unsupported_protocol","message":"v2 required","fatal":true}}',
  },
];

export interface DeltaFixture {
  name: string;
  previous: unknown;
  next: unknown;
  keyField?: string;
  /** Expected ops, or `null` when the encoder MUST bail to snapshot. */
  expected: RowOp[] | null;
}

export const DELTA_FIXTURES: DeltaFixture[] = [
  { name: 'noop', previous: [], next: [], expected: [] },
  {
    name: 'insert into empty',
    previous: [],
    next: [{ id: 'a', n: 1 }],
    expected: [{ op: 'insert', key: 'a', row: { id: 'a', n: 1 }, before: null }],
  },
  {
    name: 'insert head',
    previous: [{ id: 'b' }],
    next: [{ id: 'a' }, { id: 'b' }],
    expected: [{ op: 'insert', key: 'a', row: { id: 'a' }, before: 'b' }],
  },
  {
    name: 'insert middle',
    previous: [{ id: 'a' }, { id: 'c' }],
    next: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    expected: [{ op: 'insert', key: 'b', row: { id: 'b' }, before: 'c' }],
  },
  {
    name: 'insert tail',
    previous: [{ id: 'a' }],
    next: [{ id: 'a' }, { id: 'b' }],
    expected: [{ op: 'insert', key: 'b', row: { id: 'b' }, before: null }],
  },
  {
    name: 'update in place',
    previous: [{ id: 'a', n: 1 }],
    next: [{ id: 'a', n: 2 }],
    expected: [{ op: 'update', key: 'a', row: { id: 'a', n: 2 } }],
  },
  {
    name: 'delete one',
    previous: [{ id: 'a' }, { id: 'b' }],
    next: [{ id: 'a' }],
    expected: [{ op: 'delete', key: 'b' }],
  },
  {
    name: 'mixed delete+update+insert',
    previous: [
      { id: 'a', n: 1 },
      { id: 'b', n: 1 },
      { id: 'c', n: 1 },
    ],
    next: [
      { id: 'b', n: 2 },
      { id: 'd', n: 1 },
      { id: 'c', n: 1 },
    ],
    expected: [
      { op: 'delete', key: 'a' },
      { op: 'update', key: 'b', row: { id: 'b', n: 2 } },
      { op: 'insert', key: 'd', row: { id: 'd', n: 1 }, before: 'c' },
    ],
  },
  {
    name: 'stacked inserts share an anchor in next order',
    previous: [{ id: 'z' }],
    next: [{ id: 'x' }, { id: 'y' }, { id: 'z' }],
    expected: [
      { op: 'insert', key: 'x', row: { id: 'x' }, before: 'z' },
      { op: 'insert', key: 'y', row: { id: 'y' }, before: 'z' },
    ],
  },
  {
    name: 'custom key field',
    previous: [{ _key: 'a', n: 1 }],
    next: [{ _key: 'a', n: 2 }],
    keyField: '_key',
    expected: [{ op: 'update', key: 'a', row: { _key: 'a', n: 2 } }],
  },
  // ---- bail cases (expected: null → full snapshot) ----
  {
    name: 'bail: clear list (rule 5)',
    previous: [{ id: 'a' }, { id: 'b' }],
    next: [],
    expected: null,
  },
  {
    name: 'bail: near-total change (rule 5)',
    previous: [{ id: 'a' }, { id: 'b' }],
    next: [{ id: 'c' }, { id: 'd' }, { id: 'e' }],
    expected: null,
  },
  {
    name: 'bail: previous not array (rule 1)',
    previous: { id: 'a' },
    next: [{ id: 'a' }],
    expected: null,
  },
  {
    name: 'bail: next not array (rule 1)',
    previous: [{ id: 'a' }],
    next: { id: 'a' },
    expected: null,
  },
  {
    name: 'bail: row missing key (rule 2)',
    previous: [{ id: 'a' }],
    next: [{ text: 'no key' }],
    expected: null,
  },
  {
    name: 'bail: non-string key (rule 2)',
    previous: [{ id: 'a' }],
    next: [{ id: 5 }],
    expected: null,
  },
  { name: 'bail: scalar row (rule 2)', previous: [{ id: 'a' }], next: ['a'], expected: null },
  {
    name: 'bail: duplicate key in previous (rule 3)',
    previous: [{ id: 'a' }, { id: 'a' }],
    next: [{ id: 'a' }],
    expected: null,
  },
  {
    name: 'bail: duplicate key in next (rule 3)',
    previous: [{ id: 'a' }],
    next: [{ id: 'a' }, { id: 'a' }],
    expected: null,
  },
  {
    name: 'bail: survivors reordered (rule 4)',
    previous: [{ id: 'a' }, { id: 'b' }],
    next: [{ id: 'b' }, { id: 'a' }],
    expected: null,
  },
];

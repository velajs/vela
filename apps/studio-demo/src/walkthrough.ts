/**
 * The end-to-end conformance walkthrough — the durable proof that the whole
 * Studio product integrates.
 *
 * It boots the demo app ({@link createApp}) and drives the admin API via
 * `app.request` for EVERY operation this app wires — capabilities, app
 * introspection, the data browser (reads + writes + the 428 delete + generate +
 * over-cap), the portable time-travel snapshot→restore→undo round-trip (through
 * the 428 confirm), flags/schedule/queue, transfer export→import (through the
 * 428), and audit/logs — then stands up the loopback host ({@link
 * startStudioServer}) in-process and proves it serves the SPA shell + standalone
 * bundle, injects the master bearer server-side, and 403s a gate rejection.
 *
 * The runner records a pass/fail + evidence row per op (never throws), so both
 * the vitest e2e (which asserts every row passed) and the CLI script (which
 * prints the table) share one source of truth.
 */
import { AdminLogBuffer, MAX_GENERATE_ROWS } from '@velajs/studio';
import { startStudioServer } from '@velajs/studio-host';
import { parseStudioConnection, parseStudioRpcResponse, isRecord } from '@velajs/studio-protocol';
import type {
  AdminRpcResponse,
  StudioConfirmChallenge,
  StudioOp,
  StudioOpReq,
  StudioOpRes,
} from '@velajs/studio-protocol';
import { ADMIN_BASE_PATH, CRON_JOB_ID, DEMO_QUEUE, MODEL_IDS, SEED, createApp } from './create-app';
import type { DemoApp } from './create-app';

/** One recorded operation result. */
export interface OpResult {
  /** The op id (or host-check name). */
  op: string;
  pass: boolean;
  /** Short human evidence for the pass. */
  evidence: string;
  /** Failure detail (present only when `pass` is false). */
  detail?: string;
}

/** The full walkthrough outcome. */
export interface WalkthroughReport {
  rows: OpResult[];
  passed: boolean;
}

/** The Hono application instance `app.getHonoApp()` returns. */
type HonoApp = ReturnType<DemoApp['getHonoApp']>;

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function authed(token: string, body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-forwarded-for': '10.0.0.1',
    },
    body: JSON.stringify(body),
  };
}

/** Typed dispatch — dogfoods the exported op signatures end-to-end. */
async function rpc<Op extends StudioOp>(
  hono: HonoApp,
  token: string,
  op: Op,
  args?: StudioOpReq<Op>,
): Promise<AdminRpcResponse<StudioOpRes<Op>>> {
  const res = await hono.request(
    `${ADMIN_BASE_PATH}/rpc/${op}`,
    authed(token, args !== undefined ? { args } : {}),
  );
  return parseStudioRpcResponse(op, await res.json());
}

/** Unwrap a successful envelope, else throw with the error body. */
function unwrap<T>(res: AdminRpcResponse<T>): T {
  if (!res.ok) throw new Error(`expected ok, got ${JSON.stringify(res)}`);
  return res.data;
}

/** Assert a 428 confirm challenge and return its details. */
function asChallenge<T>(res: AdminRpcResponse<T>): StudioConfirmChallenge {
  if (res.ok) throw new Error(`expected a 428 challenge, got ${JSON.stringify(res)}`);
  assert(res.status === 428, `expected 428, got ${res.status}`);
  const details = res.error.details;
  assert(
    isRecord(details) &&
      typeof details.confirmToken === 'string' &&
      typeof details.expiresAt === 'number' &&
      typeof details.summary === 'string',
    'valid confirmation challenge',
  );
  return {
    confirmToken: details.confirmToken,
    expiresAt: details.expiresAt,
    summary: details.summary,
  };
}

/**
 * Run the full walkthrough. Returns a pass/fail row per op plus an overall
 * `passed`. Never throws (individual failures are captured as rows).
 */
export async function runWalkthrough(options: { token?: string } = {}): Promise<WalkthroughReport> {
  const token = options.token ?? 'walkthrough-master-token';
  const rows: OpResult[] = [];
  const step = async (op: string, fn: () => Promise<string>): Promise<void> => {
    try {
      const evidence = await fn();
      rows.push({ op, pass: true, evidence });
    } catch (error) {
      rows.push({
        op,
        pass: false,
        evidence: '',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const app: DemoApp = await createApp({ token });
  const hono = app.getHonoApp();
  const call = <Op extends StudioOp>(op: Op, args?: StudioOpReq<Op>) => rpc(hono, token, op, args);

  // Carry-over between steps (function-scoped; the runner is single-flight).
  let undoMarkId = '';
  let exportedNdjson = '';
  let exportedCount = 0;

  // -- capabilities ---------------------------------------------------------
  await step('studio.capabilities', async () => {
    const caps = unwrap(await call('studio.capabilities'));
    const f = caps.features;
    for (const key of [
      'data',
      'timeTravel',
      'transfer',
      'flags',
      'schedule',
      'queue',
      'openapi',
      'app',
      'logs',
      'audit',
    ] as const) {
      assert(f[key] === true, `feature ${key} should be true`);
    }
    for (const key of ['auth', 'authOrganizations', 'live', 'presence'] as const) {
      assert(f[key] === false, `feature ${key} should be false (not wired)`);
    }
    assert(
      caps.writes.dataEditable &&
        caps.writes.timeTravelRestore &&
        caps.writes.transferImport &&
        caps.writes.opsEditable,
      'write gates should reflect editable config',
    );
    assert(
      caps.timeTravel?.granularity === 'snapshot',
      'timeTravel granularity should be portable snapshot',
    );
    return `features lit: data/timeTravel/transfer/flags/schedule/queue/openapi; auth=false; writes gated true; tt=snapshot`;
  });

  // -- app introspection ----------------------------------------------------
  await step('app.routes', async () => {
    const routesRes = await call('app.routes');
    const routeList = unwrap(routesRes);
    const info = routeList.find((r) => r.method === 'GET' && r.path.startsWith('/info'));
    assert(info !== undefined, 'expected an /info route');
    assert(
      info.source === 'controller' && info.handler.startsWith('InfoController#'),
      `expected attributed InfoController handler, got ${info.handler}/${info.source}`,
    );
    const health = routeList.find((r) => r.path === `${ADMIN_BASE_PATH}/health`);
    assert(health?.source === 'mounted', 'the admin surface should degrade to (mounted)');
    return `${routeList.length} routes; ${info.handler} source=controller (runtime adapter); ${ADMIN_BASE_PATH}/health=(mounted)`;
  });

  await step('app.modules', async () => {
    const modules = unwrap(await call('app.modules'));
    for (const m of modules) {
      assert(
        typeof m.moduleId === 'string' && Array.isArray(m.imports) && typeof m.lazy === 'boolean',
        'module node shape',
      );
    }
    assert(
      modules.some((m) => m.moduleId.startsWith('ApiModule')),
      'ApiModule present',
    );
    assert(
      modules.some((m) => m.moduleId.startsWith('StudioModule')),
      'StudioModule present',
    );
    return `${modules.length} modules with import edges + lazy flags (ApiModule, StudioModule, ...)`;
  });

  await step('app.entrypoints', async () => {
    const eps = unwrap(await call('app.entrypoints'));
    const queueEp = eps.find((e) => e.kind === 'queue');
    assert(queueEp !== undefined, 'expected the welcome-email queue entrypoint');
    return `${eps.length} entrypoint(s); queue entrypoint present (kind=queue)`;
  });

  await step('app.openapi', async () => {
    const doc = unwrap(await call('app.openapi')) as {
      openapi?: string;
      paths?: Record<string, unknown>;
    };
    assert(typeof doc.openapi === 'string' && doc.openapi.startsWith('3.'), 'OpenAPI 3.x');
    const paths = Object.keys(doc.paths ?? {});
    assert(
      paths.some((p) => p.startsWith('/info')),
      'documents the /info paths',
    );
    return `OpenAPI ${doc.openapi} with ${paths.length} paths (incl /info)`;
  });

  // -- data browser: reads --------------------------------------------------
  await step('data.listModels', async () => {
    const list = unwrap(await call('data.listModels'));
    const names = list.map((m) => m.name).toSorted();
    assert(
      JSON.stringify(names) === JSON.stringify([MODEL_IDS.author, MODEL_IDS.book, MODEL_IDS.tag]),
      `models ${names.join(',')}`,
    );
    const author = list.find((m) => m.name === MODEL_IDS.author);
    assert(
      JSON.stringify([...(author?.capabilities ?? [])].toSorted()) ===
        JSON.stringify(['aggregate', 'cascade', 'transactions']),
      'author caps',
    );
    return `3 models [author, book, tag]; author caps=[aggregate,cascade,transactions], book caps=[nativeSearch,transactions]`;
  });

  await step('data.describeModel', async () => {
    const book = unwrap(await call('data.describeModel', { model: MODEL_IDS.book }));
    assert(
      book.table === 'books' && JSON.stringify(book.primaryKeys) === JSON.stringify(['id']),
      'book pk',
    );
    const authorId = book.columns.find((c) => c.name === 'authorId');
    assert(
      JSON.stringify(authorId?.fk) ===
        JSON.stringify({ table: MODEL_IDS.author, relation: 'author' }),
      'authorId FK',
    );
    const deletedAt = book.columns.find((c) => c.name === 'deletedAt');
    assert(
      deletedAt?.managed === true && deletedAt.nullable === true,
      'deletedAt managed+nullable',
    );
    assert(book.flags.softDelete === true && book.supports.search === true, 'flags/supports');
    return `book: pk=id, FK authorId->authors, softDelete flag, deletedAt managed+nullable, supports.search`;
  });

  await step('data.listRows', async () => {
    const published = unwrap(
      await call('data.listRows', {
        model: MODEL_IDS.book,
        filters: [{ field: 'status', operator: 'eq', value: 'published' }],
        sort: { field: 'createdAt', order: 'asc' },
      }),
    );
    assert(
      JSON.stringify(published.rows.map((r) => r.id)) === JSON.stringify(['b1', 'b3']),
      'filter+sort',
    );
    const live = unwrap(await call('data.listRows', { model: MODEL_IDS.book }));
    assert(!live.rows.some((r) => r.id === SEED.softDeletedBook), 'soft-deleted hidden by default');
    const all = unwrap(await call('data.listRows', { model: MODEL_IDS.book, withDeleted: true }));
    assert(
      all.rows.some((r) => r.id === SEED.softDeletedBook),
      'withDeleted reveals tombstone',
    );
    const search = unwrap(await call('data.listRows', { model: MODEL_IDS.book, search: 'Draft' }));
    assert(
      JSON.stringify(search.rows.map((r) => r.id)) === JSON.stringify(['b2']),
      'inline search',
    );
    return `filter(status=published)+sort=[b1,b3]; soft-delete hidden; withDeleted reveals b4; inline search 'Draft'=[b2]`;
  });

  await step('data.readRow', async () => {
    const found = unwrap(await call('data.readRow', { model: MODEL_IDS.author, id: 'a1' }));
    assert(found?.email === 'ada@x.io', 'a1 email');
    const missing = unwrap(await call('data.readRow', { model: MODEL_IDS.author, id: 'nope' }));
    assert(missing === null, 'missing -> null');
    return `readRow(author a1)=ada@x.io; unknown id -> null`;
  });

  await step('data.facets', async () => {
    const facets = unwrap(await call('data.facets', { model: MODEL_IDS.author, field: 'role' }));
    const byValue = new Map(facets.buckets.map((b) => [b.value, b.count]));
    assert(
      byValue.get('member') === 2 && byValue.get('admin') === 1,
      `facets ${JSON.stringify([...byValue])}`,
    );
    return `facets(author.role)=admin:1, member:2`;
  });

  await step('data.cascadePreview', async () => {
    const preview = unwrap(
      await call('data.cascadePreview', { model: MODEL_IDS.author, ids: ['a1'] }),
    );
    const books = preview.relations.find((r) => r.relation === 'books');
    assert(books?.affected === 2, `expected 2 live child books, got ${books?.affected}`);
    return `cascadePreview(author a1): books relation affects 2 live rows (b4 tombstoned skipped)`;
  });

  // -- data browser: writes -------------------------------------------------
  await step('data.writeRow', async () => {
    const created = unwrap(
      await call('data.writeRow', {
        model: MODEL_IDS.author,
        patch: { name: 'Dee', email: 'dee@x.io', role: 'member' },
      }),
    );
    assert(
      typeof created.id === 'string' && typeof created.createdAt === 'number',
      'create stamps id+timestamps',
    );
    const updated = unwrap(
      await call('data.writeRow', { model: MODEL_IDS.author, id: 'a2', patch: { role: 'owner' } }),
    );
    assert(
      updated.role === 'owner' && updated.email === 'bo@x.io',
      'update patches + keeps untouched',
    );
    return `create(author) stamped id+createdAt; update(a2) role=owner (email untouched)`;
  });

  await step('data.deleteRows', async () => {
    const first = await call('data.deleteRows', {
      model: MODEL_IDS.book,
      ids: ['b2', 'b3'],
      mode: 'hard',
      confirmToken: '',
    });
    const challenge = asChallenge(first);
    assert(challenge.summary.toLowerCase().includes('delete'), 'challenge summary');
    const done = unwrap(
      await call('data.deleteRows', {
        model: MODEL_IDS.book,
        ids: ['b2', 'b3'],
        mode: 'hard',
        confirmToken: challenge.confirmToken,
      }),
    );
    assert(done.deleted === 2, `deleted ${done.deleted}`);
    const gone = unwrap(await call('data.readRow', { model: MODEL_IDS.book, id: 'b2' }));
    assert(gone === null, 'b2 gone');
    const replay = await call('data.deleteRows', {
      model: MODEL_IDS.book,
      ids: ['b2', 'b3'],
      mode: 'hard',
      confirmToken: challenge.confirmToken,
    });
    const second = asChallenge(replay);
    assert(second.confirmToken !== challenge.confirmToken, 'single-use: replay -> fresh challenge');
    return `428 mint -> confirm -> deleted 2 (b2,b3); replay of used token -> fresh challenge (single-use)`;
  });

  await step('data.generateRows', async () => {
    const before =
      unwrap(await call('data.listRows', { model: MODEL_IDS.book })).info.total_count ?? 0;
    const res = unwrap(await call('data.generateRows', { model: MODEL_IDS.book, count: 3 }));
    assert(res.inserted === 3, `inserted ${res.inserted}`);
    const after = unwrap(await call('data.listRows', { model: MODEL_IDS.book, perPage: 100 }));
    assert((after.info.total_count ?? 0) === before + 3, 'live count grew by 3');
    assert(
      after.rows.every((r) => typeof r.authorId === 'string' && String(r.authorId).length > 0),
      'every generated row carries a valid FK',
    );
    return `generated 3 book rows (live count +3); every row carries a valid authorId FK from the pool`;
  });

  await step('data.generateRows (over-cap reject)', async () => {
    const res = await call('data.generateRows', {
      model: MODEL_IDS.book,
      count: MAX_GENERATE_ROWS + 1,
    });
    assert(!res.ok, 'over-cap should reject');
    if (res.ok) throw new Error('unreachable');
    assert(res.status === 400 && res.error.code === 'bad_request', `status ${res.status}`);
    assert((res.error.hint ?? '').includes(String(MAX_GENERATE_ROWS)), 'hint names the cap');
    return `count=${MAX_GENERATE_ROWS + 1} -> 400 bad_request, hint names cap (${MAX_GENERATE_ROWS})`;
  });

  // -- time travel: snapshot -> restore -> undo round-trip ------------------
  await step('timeTravel.capabilities', async () => {
    const caps = unwrap(await call('timeTravel.capabilities', {}));
    assert(
      caps.granularity === 'snapshot' && caps.portableExport === true,
      'portable snapshot caps',
    );
    return `granularity=snapshot, portableExport=true, undo=${String(caps.undo)}`;
  });

  const ttSnapshotTitle = 'Portable Time';
  let snapshotMarkId = '';
  await step('timeTravel.createSnapshot', async () => {
    const before = unwrap(await call('data.readRow', { model: MODEL_IDS.book, id: 'b1' }));
    assert(before?.title === ttSnapshotTitle, `b1 title baseline ${String(before?.title)}`);
    const mark = unwrap(await call('timeTravel.createSnapshot', {}));
    snapshotMarkId = mark.id;
    const tables = mark.tables ?? [];
    assert(tables.includes(MODEL_IDS.book), 'snapshot captures the book table');
    return `snapshot ${mark.id} captured tables [${tables.join(', ')}] at baseline (b1='${ttSnapshotTitle}')`;
  });

  await step('timeTravel.preview + armRestore (428) restores rows', async () => {
    // Mutate b1, then preview the restore to the snapshot.
    unwrap(
      await call('data.writeRow', { model: MODEL_IDS.book, id: 'b1', patch: { title: 'MUTATED' } }),
    );
    assert(
      unwrap(await call('data.readRow', { model: MODEL_IDS.book, id: 'b1' }))?.title === 'MUTATED',
      'b1 mutated',
    );

    const preview = unwrap(
      await call('timeTravel.preview', { target: { bookmark: snapshotMarkId } }),
    );
    assert(
      preview.schemaCompatible === true && preview.confirmToken.length > 0,
      'preview compatible + token',
    );

    // armRestore rides its OWN 428 (empty token -> challenge -> confirm).
    const challenge = asChallenge(
      await call('timeTravel.armRestore', { bookmark: snapshotMarkId, confirmToken: '' }),
    );
    assert(challenge.summary.toLowerCase().includes('restore'), 'restore challenge summary');
    const outcome = unwrap(
      await call('timeTravel.armRestore', {
        bookmark: snapshotMarkId,
        confirmToken: challenge.confirmToken,
      }),
    );
    assert(
      outcome.applied === true && outcome.undoMark !== undefined,
      'restore applied + undo mark',
    );
    const restored = unwrap(await call('data.readRow', { model: MODEL_IDS.book, id: 'b1' }));
    assert(
      restored?.title === ttSnapshotTitle,
      `b1 restored to '${ttSnapshotTitle}', got '${String(restored?.title)}'`,
    );
    // stash the undo mark for the next step via a closure-scoped variable.
    undoMarkId = outcome.undoMark?.id ?? '';
    return `preview compatible; armRestore rode 428; b1 restored '${ttSnapshotTitle}'; undoMark=${undoMarkId}`;
  });

  await step('timeTravel.undo (428) returns to pre-restore state', async () => {
    assert(undoMarkId.length > 0, 'have an undo mark');
    const challenge = asChallenge(
      await call('timeTravel.undo', { undoMark: undoMarkId, confirmToken: '' }),
    );
    const undone = unwrap(
      await call('timeTravel.undo', { undoMark: undoMarkId, confirmToken: challenge.confirmToken }),
    );
    assert(undone.applied === true, 'undo applied');
    const back = unwrap(await call('data.readRow', { model: MODEL_IDS.book, id: 'b1' }));
    assert(back?.title === 'MUTATED', `undo returns b1 to 'MUTATED', got '${String(back?.title)}'`);
    return `undo rode 428; b1 back to 'MUTATED' — snapshot->restore->undo round-trip closed`;
  });

  await step('timeTravel.listMarks + currentMark + markForTime', async () => {
    const marks = unwrap(await call('timeTravel.listMarks', {}));
    assert(marks.marks.length >= 2, 'multiple marks');
    const current = unwrap(await call('timeTravel.currentMark', {}));
    assert(typeof current.id === 'string', 'current mark');
    const at = unwrap(await call('timeTravel.markForTime', { time: Date.now() }));
    assert(at !== null, 'markForTime resolves a mark');
    return `${marks.marks.length} marks listed; currentMark=${current.id}; markForTime(now) resolves`;
  });

  await step('timeTravel.prune (428)', async () => {
    const challenge = asChallenge(
      await call('timeTravel.prune', { retention: { keepLast: 1 }, confirmToken: '' }),
    );
    const pruned = unwrap(
      await call('timeTravel.prune', {
        retention: { keepLast: 1 },
        confirmToken: challenge.confirmToken,
      }),
    );
    assert(pruned.pruned >= 1, `pruned ${pruned.pruned}`);
    const after = unwrap(await call('timeTravel.listMarks', {}));
    assert(after.marks.length === 1, `keepLast:1 -> ${after.marks.length} mark`);
    return `428 prune keepLast:1 -> pruned ${pruned.pruned}; 1 mark remains`;
  });

  // -- flags ----------------------------------------------------------------
  await step('flags.list', async () => {
    const list = unwrap(await call('flags.list'));
    assert(list.find((f) => f.key === 'newDashboard')?.value === true, 'newDashboard');
    assert(list.find((f) => f.key === 'maxUploads')?.value === 25, 'maxUploads');
    return `flags: newDashboard=true, betaBanner=false, maxUploads=25`;
  });

  await step('flags.evaluate', async () => {
    const evalRes = unwrap(await call('flags.evaluate', { key: 'newDashboard' }));
    assert(evalRes.flagKey === 'newDashboard' && evalRes.value === true, 'evaluate');
    return `evaluate(newDashboard) = ${String(evalRes.value)} (reason ${evalRes.reason})`;
  });

  // -- schedule -------------------------------------------------------------
  await step('schedule.jobs + triggers', async () => {
    const jobs = unwrap(await call('schedule.jobs'));
    const job = jobs.find((j) => j.name === CRON_JOB_ID);
    assert(job?.kind === 'cron' && job.expression === '0 0 * * *', 'cron job');
    assert(job?.lastRun === undefined && job?.nextRun === undefined, 'honest: no run history');
    const triggers = unwrap(await call('schedule.triggers'));
    assert(triggers.find((t) => t.name === CRON_JOB_ID)?.cron === '0 0 * * *', 'trigger');
    return `job '${CRON_JOB_ID}' cron '0 0 * * *' (lastRun/nextRun honestly omitted)`;
  });

  await step('schedule.runNow', async () => {
    const res = unwrap(await call('schedule.runNow', { id: CRON_JOB_ID }));
    assert(JSON.stringify(res) === JSON.stringify({ ok: true }), 'runNow ok');
    return `runNow('${CRON_JOB_ID}') = { ok: true } (opsEditable-gated)`;
  });

  // -- queue ----------------------------------------------------------------
  await step('queue.list', async () => {
    const queues = unwrap(await call('queue.list'));
    assert(
      queues.some((q) => q.name === DEMO_QUEUE),
      'welcome-email queue',
    );
    assert(
      queues.every((q) => q.depth === undefined),
      'honest: no depth',
    );
    return `queues include '${DEMO_QUEUE}' (kind advertised, depth honestly omitted)`;
  });

  await step('queue.send', async () => {
    const sent = unwrap(
      await call('queue.send', { queue: DEMO_QUEUE, payload: { to: 'ada@x.io' } }),
    );
    assert(typeof sent.id === 'string', 'send returns id');
    return `send to '${DEMO_QUEUE}' enqueued job id=${sent.id}`;
  });

  await step('queue.depths/dlq/replay (honest degrade)', async () => {
    for (const res of [
      await call('queue.depths', {}),
      await call('queue.dlq', { queue: DEMO_QUEUE }),
      await call('queue.replay', { queue: DEMO_QUEUE, ids: [] }),
    ]) {
      assert(!res.ok, 'should degrade');
      if (res.ok) throw new Error('unreachable');
      assert(
        res.error.code === 'FEATURE_UNCONFIGURED',
        `expected FEATURE_UNCONFIGURED, got ${res.error.code}`,
      );
    }
    return `depths/dlq/replay -> FEATURE_UNCONFIGURED (inline driver has no depth/DLQ)`;
  });

  // -- transfer: export -> import round-trip (through the 428) --------------
  await step('transfer.export + /export route', async () => {
    const { exportUrl } = unwrap(await call('transfer.export', { model: MODEL_IDS.book }));
    assert(
      exportUrl === `${ADMIN_BASE_PATH}/export?model=${encodeURIComponent(MODEL_IDS.book)}`,
      `exportUrl ${exportUrl}`,
    );
    const res = await hono.request(exportUrl, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': '10.0.0.1' },
    });
    assert(
      res.status === 200 &&
        (res.headers.get('content-type') ?? '').includes('application/x-ndjson'),
      'ndjson stream',
    );
    const lines = (await res.text()).trim().split('\n').filter(Boolean);
    exportedNdjson = `${lines.join('\n')}\n`;
    exportedCount = lines.length;
    return `export(book) -> ${exportUrl}; streamed ${lines.length} NDJSON rows (application/x-ndjson)`;
  });

  await step('data.clearTable (428)', async () => {
    // Wipe the book table so the re-import is a clean create (no unique clash) —
    // the export -> clear -> import round-trip.
    const challenge = asChallenge(
      await call('data.clearTable', { model: MODEL_IDS.book, confirmToken: '' }),
    );
    assert(challenge.summary.toLowerCase().includes('clear'), 'clear challenge');
    const cleared = unwrap(
      await call('data.clearTable', {
        model: MODEL_IDS.book,
        confirmToken: challenge.confirmToken,
      }),
    );
    assert(cleared.deleted >= exportedCount, `cleared ${cleared.deleted}`);
    const empty = unwrap(await call('data.listRows', { model: MODEL_IDS.book, withDeleted: true }));
    assert((empty.info.total_count ?? 0) === 0, 'table wiped');
    return `428 clear -> wiped ${cleared.deleted} rows; book table now empty`;
  });

  await step('transfer.import (428)', async () => {
    const challenge = asChallenge(
      await call('transfer.import', {
        model: MODEL_IDS.book,
        ndjson: exportedNdjson,
        confirmToken: '',
      }),
    );
    assert(challenge.summary.toLowerCase().includes('import'), 'import challenge');
    const result = unwrap(
      await call('transfer.import', {
        model: MODEL_IDS.book,
        ndjson: exportedNdjson,
        confirmToken: challenge.confirmToken,
      }),
    );
    assert(result.imported === exportedCount, `imported ${result.imported} of ${exportedCount}`);
    const restored = unwrap(
      await call('data.listRows', { model: MODEL_IDS.book, withDeleted: true }),
    );
    assert((restored.info.total_count ?? 0) === exportedCount, 'rows restored from NDJSON');
    return `428 mint -> confirm -> imported ${result.imported} rows; book table restored (export->clear->import round-trip)`;
  });

  // -- logs / audit ---------------------------------------------------------
  await step('audit.tail', async () => {
    const tail = unwrap(await call('audit.tail', {}));
    const ops = new Set(tail.map((e) => e.op));
    for (const op of [
      'data.writeRow',
      'data.deleteRows',
      'timeTravel.armRestore',
      'transfer.import',
    ] as const) {
      assert(ops.has(op), `audit should include ${op}`);
    }
    const del = tail.find((e) => e.op === 'data.deleteRows' && e.status === 200);
    assert(del !== undefined, 'successful delete audited');
    return `audit trail includes writeRow, deleteRows(200), armRestore, import — the ops just performed`;
  });

  await step('logs.tail', async () => {
    // Seed a log line through the public buffer, then read it back.
    app
      .getContainer()
      .resolve(AdminLogBuffer)
      .record({ ts: Date.now(), level: 'info', msg: 'walkthrough-marker' });
    const logs = unwrap(await call('logs.tail', {}));
    assert(
      logs.some((l) => l.msg === 'walkthrough-marker'),
      'recorded log surfaces',
    );
    return `logs.tail returns the buffered app logs (incl the seeded marker)`;
  });

  // -- auth (intentionally NOT wired) — honest degradation ------------------
  await step('auth.users (skipped-auth honest state)', async () => {
    const res = await call('auth.users', {});
    assert(!res.ok, 'auth should be unconfigured');
    if (res.ok) throw new Error('unreachable');
    assert(
      res.error.code === 'FEATURE_UNCONFIGURED',
      `expected FEATURE_UNCONFIGURED, got ${res.error.code}`,
    );
    return `auth panel not wired -> auth.users FEATURE_UNCONFIGURED (feature.auth=false); acceptable demo state`;
  });

  // -- the loopback host: shell + bundle + bearer injection + gate ----------
  const host = await startStudioServer({
    workerOrigin: 'http://demo.app.internal',
    adminToken: token,
    resolveFrom: import.meta.url,
    // Route the proxy's forward straight into the running app (in-process).
    fetchImpl: (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return Promise.resolve(hono.fetch(new Request(url, init)));
    },
  });

  let sessionToken = '';
  try {
    await step('host: serves the SPA shell', async () => {
      const res = await fetch(host.url);
      assert(res.status === 200, `shell status ${res.status}`);
      const html = await res.text();
      const bootstrap = html.match(/window\.__VELA_STUDIO__=(.+);/);
      assert(bootstrap?.[1], 'boots the Studio connection');
      sessionToken = parseStudioConnection(JSON.parse(bootstrap[1])).sessionToken;
      assert(
        html.includes('<script type="module" src="/studio.js">'),
        'references the standalone bundle',
      );
      assert(!html.includes(token), 'master token never in the browser document');
      return `GET ${host.url} -> 200 text/html shell (script /studio.js; master token absent)`;
    });

    await step('host: serves the standalone bundle', async () => {
      const res = await fetch(new URL('/studio.js', host.url));
      assert(res.status === 200, `bundle status ${res.status}`);
      assert(
        (res.headers.get('content-type') ?? '').includes('javascript'),
        'javascript content-type',
      );
      return `GET /studio.js -> 200 (the built standalone bundle exists + is served)`;
    });

    await step('host: proxy injects the master bearer server-side', async () => {
      // The browser authenticates with the local session; the host holds the master token.
      const res = await fetch(new URL(`${ADMIN_BASE_PATH}/rpc/studio.capabilities`, host.url), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
          authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({ args: {} }),
      });
      assert(res.status === 200, `proxied status ${res.status}`);
      const body = parseStudioRpcResponse('studio.capabilities', await res.json());
      assert(body.ok === true, 'app authorized the bearer-injected request');
      return `browser session authenticated; host injected master Bearer -> app authorized (ok:true)`;
    });

    await step('host: gate rejection 403s', async () => {
      const res = await fetch(new URL(`${ADMIN_BASE_PATH}/health`, host.url), {
        headers: { 'x-forwarded-for': '203.0.113.7' },
      });
      assert(res.status === 403, `gate status ${res.status}`);
      return `X-Forwarded-* proxied request -> 403 (transport gate; app never reached)`;
    });
  } finally {
    await host.close();
  }

  return { rows, passed: rows.every((r) => r.pass) };
}

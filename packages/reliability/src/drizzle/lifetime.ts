import type { ReliabilitySession } from '../types';

/** Native sessions cannot escape or hide accepted work from the transaction runner. */
export async function withSession<T>(
  session: ReliabilitySession,
  work: (session: ReliabilitySession) => Promise<T>,
): Promise<T> {
  let active = true;
  let failed = false;
  let failure: unknown;
  const pending = new Set<Promise<unknown>>();
  const fail = (error: unknown) => {
    if (!failed) {
      failed = true;
      failure = error;
    }
  };
  function track<Args extends unknown[], Result>(
    operation: (...args: Args) => Promise<Result>,
  ): (...args: Args) => Promise<Result> {
    return (...args) => {
      if (!active) return Promise.reject(new TypeError('Expired reliability session'));
      if (failed)
        return Promise.reject(new Error('Reliability session has failed', { cause: failure }));
      if (pending.size) {
        const error = new TypeError('Await each reliability session operation');
        fail(error);
        return Promise.reject(error);
      }
      const promise = Promise.resolve().then(() => operation(...args));
      pending.add(promise);
      void promise.then(
        () => {
          pending.delete(promise);
          return undefined;
        },
        (error: unknown) => {
          fail(error);
          pending.delete(promise);
          return undefined;
        },
      );
      return promise;
    };
  }
  const bound: ReliabilitySession = Object.freeze({
    atomic: session.atomic,
    now: track(session.now),
    get: track(session.get),
    insert: track(session.insert),
    due: track(session.due),
    claim: track(session.claim),
    transition: track(session.transition),
    exhaust: track(session.exhaust),
    edit: track(session.edit),
    prune: track(session.prune),
  });
  try {
    const result = await work(bound);
    if (pending.size) fail(new TypeError('Unawaited reliability session operation'));
    if (pending.size) await Promise.allSettled(pending);
    if (failed) throw failure;
    return result;
  } finally {
    active = false;
    if (pending.size) await Promise.allSettled(pending);
  }
}

/**
 * A bulk enqueue the transport accepted only in part. `accepted` names the jobs
 * it already took (they will be delivered), `rejected` the rest; `cause` is the
 * transport failure. Retry only the rejected jobs: sending the whole batch again
 * would deliver the accepted ones twice.
 */
export class QueueBatchError extends Error {
  override readonly name = 'QueueBatchError';
  /** Ids of the jobs the transport accepted before it failed, in order. */
  readonly accepted: readonly string[];
  /** Ids of the jobs it did not accept, in order. */
  readonly rejected: readonly string[];

  constructor(accepted: readonly string[], rejected: readonly string[], cause: unknown) {
    const total = accepted.length + rejected.length;
    super(
      `The queue transport accepted ${accepted.length} of ${total} jobs before it failed. ` +
        (accepted.length > 0
          ? `Accepted job ids: ${accepted.join(', ')}.`
          : 'No job was accepted.'),
      { cause },
    );
    this.accepted = Object.freeze([...accepted]);
    this.rejected = Object.freeze([...rejected]);
  }
}

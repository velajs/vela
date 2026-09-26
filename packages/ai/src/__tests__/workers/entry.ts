/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from 'cloudflare:workers';
import { defineRag, memoryVectors } from '../../rag';
import { durableObjectPublications } from '../../vectorize';
import type { RagPublicationTransaction } from '../../rag';

declare global {
  namespace Cloudflare {
    interface Env {
      PUBLICATIONS: DurableObjectNamespace<PublicationHost>;
    }
  }
}
export class PublicationHost extends DurableObject {
  rag() {
    return defineRag({
      publications: durableObjectPublications(this.ctx.storage),
      vectors: memoryVectors(),
      embed: () => [1],
      chunkSize: 65536,
      chunkOverlap: 0,
      allowSharedNamespace: true,
    });
  }
  async seed() {
    const source = '雪'.repeat(170);
    const rag = this.rag();
    const [result] = await rag.sync([{ id: source, text: '\0'.repeat(60000) }]);
    return { source, revision: result!.revision };
  }
  async resume(source: string, revision: string) {
    const rag = this.rag();
    await rag.reconcile(source, { revision, reindex: true });
    return (await rag.retrieve('q')).chunks.map((chunk) => chunk.text).join('');
  }
  async transactions() {
    const publications = durableObjectPublications(this.ctx.storage);
    let retained: RagPublicationTransaction | undefined;
    try {
      await publications.transaction({}, async (tx) => {
        await tx.put('failed', 1);
        throw new Error('rollback');
      });
    } catch {}
    const absent = await publications.transaction({}, (tx) => tx.get('failed'));
    await publications.transaction({}, async (tx) => {
      retained = tx;
      await tx.put('large', '\0'.repeat(65536));
    });
    let closed = false;
    try {
      await retained!.put('large', 'bad');
    } catch {
      closed = true;
    }
    const large = await publications.transaction({}, (tx) => tx.get<string>('large'));
    const physical = await this.ctx.storage.list();
    return {
      absent: absent === undefined,
      closed,
      length: large!.length,
      largest: Math.max(
        ...[...physical.values()].map(
          (value) => new TextEncoder().encode(JSON.stringify(value)).length,
        ),
      ),
    };
  }
}
export default { fetch: () => new Response('test fixture') };

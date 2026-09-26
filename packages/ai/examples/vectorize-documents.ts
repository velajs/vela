/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from 'cloudflare:workers';
import {
  defineRag,
  type RagDocument,
  type RemoveOptions,
  type ReconcileOptions,
  type RetrieveOptions,
} from '@velajs/ai/rag';
import { durableObjectPublications, vectorizeVectors } from '@velajs/ai/vectorize';

interface Env {
  INDEX: Vectorize;
  AI: Ai;
  PUBLICATIONS: DurableObjectNamespace<Documents>;
}
/** Created by trusted server authentication/authorization, never from request JSON. */
interface Identity {
  tenantId: string;
  team: string;
  canWrite: boolean;
}

/** One stable authority object for this index. No public HTTP routes are provided. */
export class Documents extends DurableObject<Env> {
  private index(identity: Identity) {
    return defineRag({
      publications: durableObjectPublications(this.ctx.storage),
      vectors: vectorizeVectors(this.env.INDEX, { dimensions: 768, metric: 'cosine' }),
      embed: async (text) => {
        const result = await this.env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [text] });
        if (!('data' in result)) throw new Error('Synchronous embedding response required');
        const vector = result.data[0];
        if (!vector) throw new Error('Embedding missing');
        return vector;
      },
      embeddingModelVersion: 'bge-base-en-v1.5',
      resolveNamespace: ({ operation, selector }) => {
        if (!identity.tenantId || (selector !== undefined && selector !== identity.tenantId))
          throw new Error('Tenant denied');
        if (operation !== 'retrieve' && !identity.canWrite)
          throw new Error('Writer access required');
        return identity.tenantId;
      },
      rlsFilter: () => ({ team: identity.team }),
    });
  }
  sync(identity: Identity, docs: RagDocument[]) {
    return this.index(identity).sync(docs);
  }
  retrieve(identity: Identity, query: string, options?: RetrieveOptions) {
    return this.index(identity).retrieve(query, options);
  }
  inspect(identity: Identity, id: string) {
    return this.index(identity).inspect(id);
  }
  remove(identity: Identity, id: string, options: RemoveOptions) {
    return this.index(identity).remove(id, options);
  }
  reconcile(identity: Identity, id: string, options: ReconcileOptions) {
    return this.index(identity).reconcile(id, options);
  }
}
/** Call only after authenticating the caller and constructing Identity on the server. */
export const documents = (env: Env) =>
  env.PUBLICATIONS.getByName('manuals-publication-authority-v1');

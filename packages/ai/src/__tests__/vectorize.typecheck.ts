import type { Vectorize, DurableObjectStorage } from '@cloudflare/workers-types';
import { vectorizeVectors, durableObjectPublications } from '../vectorize';
import type { RagPublications, RagVectors } from '../rag';
export const nativeTypes = (binding: Vectorize, storage: DurableObjectStorage) => {
  const vectors = vectorizeVectors(binding, { dimensions: 768, metric: 'cosine' });
  const portable: RagVectors = vectors;
  const publications: RagPublications = durableObjectPublications(storage);
  const original: Vectorize = vectors.binding;
  return { portable, publications, original };
};
// Compile the packaged native recipe against public exports and generated native types.
export { Documents, documents } from '../../examples/vectorize-documents';

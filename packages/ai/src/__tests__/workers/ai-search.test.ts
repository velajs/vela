import { expect, it } from 'vitest';
import { createAiSearch } from '../../ai-search';

it('runs managed retrieval and authorization in workerd without Node compatibility', async () => {
  let published = true;
  const search = createAiSearch({
    instanceIds: ['manuals'],
    authorizeSource: ({ instanceId, key }) =>
      published && instanceId === 'manuals' && key === 'guide/v1.md',
    // AI Search has no local indexing emulator. This checks the Web API runtime
    // and binding boundary; live search requires a separately provisioned remote instance.
    binding: {
      async search(request) {
        expect(request.ai_search_options.instance_ids).toEqual(['manuals']);
        return {
          chunks: [
            {
              instance_id: 'manuals',
              id: 'chunk-1',
              type: 'text',
              score: 0.9,
              text: 'An indexed passage.',
              item: { key: 'guide/v1.md' },
            },
          ],
        };
      },
    },
  });
  const result = await search.retrieve('guide');
  expect(result.context).toBe('[source:1]\nAn indexed passage.');
  expect(result.citations[0]?.key).toBe('guide/v1.md');
  published = false;
  expect(await search.retrieve('guide')).toEqual({ context: '', chunks: [], citations: [] });
});

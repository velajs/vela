import { describe, expect, it } from 'vitest';
import { deriveVerbNaming, pascalResourceName } from '../naming';

describe('generated resource names', () => {
  it.each([
    ['', ''],
    ['users', 'Users'],
    ['userProfiles', 'UserProfiles'],
    ['order-items', 'OrderItems'],
    ['/order__items 2026', 'OrderItems2026'],
    ['9lives', '9lives'],
    ['café items', 'CafItems'],
    ['users///', 'Users///'],
    ['///', '///'],
    ['\nitems\n', 'Items\n'],
  ])('keeps the existing name for %j', (input, output) => {
    expect(pascalResourceName(input)).toBe(output);
  });

  it('handles long separator runs, including unmatched suffixes', () => {
    const separators = '/'.repeat(100_000);
    expect(pascalResourceName(separators)).toBe(separators);
    expect(pascalResourceName(`${separators}items${separators}`)).toBe(`Items${separators}`);
    expect(deriveVerbNaming('list', 'item', `items${separators}`)?.operationId).toBe(
      `listItems${separators}`,
    );
  });

  it('retains public operation IDs and summaries', () => {
    expect(deriveVerbNaming('list', 'order-item', 'order-items')).toEqual({
      operationId: 'listOrderItems',
      summary: 'List order-items',
    });
    expect(deriveVerbNaming('versionRollback', 'document', 'documents')).toEqual({
      operationId: 'rollbackDocumentVersion',
      summary: 'Rollback document version',
    });
  });
});

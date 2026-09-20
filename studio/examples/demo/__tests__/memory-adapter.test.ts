import { describe, expect, it } from 'vitest';
import { MemoryDb, memoryAdapter } from '../src/memory-adapter';
import { models } from '../src/models';

describe('demo memory adapter scopes', () => {
  it('rolls back writes across tables and keeps existing adapter references usable', async () => {
    const db = new MemoryDb();
    db.seed(models.author.tableName, [{ id: 'author-1', name: 'Original' }]);
    const authors = memoryAdapter(models.author, db);
    const books = memoryAdapter(models.book, db);
    await expect(authors.transaction(async (scope) => {
      await authors.update({ field: 'id', value: 'author-1' }, { name: 'Changed' }, scope);
      await books.create({ id: 'book-1', title: 'Temporary' }, scope);
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(await authors.requestScope((scope) => authors.readOne({ field: 'id', value: 'author-1' }, {}, scope))).toEqual({ id: 'author-1', name: 'Original' });
    expect(await books.requestScope((scope) => books.readOne({ field: 'id', value: 'book-1' }, {}, scope))).toBeNull();
    await books.transaction((scope) => books.create({ id: 'book-2', title: 'Committed' }, scope));
    expect(db.table(models.book.tableName).get('book-2')?.title).toBe('Committed');
  });

  it('does not expose a partially completed transaction to a concurrent request', async () => {
    const db = new MemoryDb();
    const authors = memoryAdapter(models.author, db);
    let release = () => {};
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let started = () => {};
    const writing = new Promise<void>((resolve) => { started = resolve; });
    const write = authors.transaction(async (scope) => {
      await authors.create({ id: 'a', name: 'Pending' }, scope);
      started();
      await paused;
      await authors.update({ field: 'id', value: 'a' }, { name: 'Complete' }, scope);
    });
    await writing;
    const read = authors.requestScope((scope) => authors.readOne({ field: 'id', value: 'a' }, {}, scope));
    release();
    await write;
    expect(await read).toEqual({ id: 'a', name: 'Complete' });
  });
});

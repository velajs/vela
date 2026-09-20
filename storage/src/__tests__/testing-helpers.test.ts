import { describe, expect, it } from 'vitest';
import { createStorage } from '../storage.facade';
import { StorageService } from '../storage.service';
import { memoryDriver } from '../drivers/memory';
import { assertCount, assertExists, assertMissing } from '../testing';

// The memory driver IS the fake; these helpers assert against any memory-backed
// disk (StorageService or the bare Storage facade). Every helper is exercised
// on a real memory-driver `StorageService` instance, positive and negative.

const service = () => new StorageService(() => memoryDriver(), { name: 'test' });
const disk = () => createStorage({ driver: memoryDriver() });

describe('@velajs/storage/testing', () => {
  describe('assertExists', () => {
    it('passes for an object that exists on a StorageService', async () => {
      const s = service();
      await s.upload('a.txt', 'hello');
      await expect(assertExists(s, 'a.txt')).resolves.toBeUndefined();
    });

    it('throws with a clear message when the object is missing', async () => {
      const s = service();
      await expect(assertExists(s, 'nope.txt')).rejects.toThrow(/assertExists.*"nope\.txt".*exist/);
    });

    it('also works against a bare Storage facade', async () => {
      const d = disk();
      await d.upload('b.txt', 'x');
      await expect(assertExists(d, 'b.txt')).resolves.toBeUndefined();
    });
  });

  describe('assertMissing', () => {
    it('passes when nothing is stored at the path', async () => {
      const s = service();
      await expect(assertMissing(s, 'ghost.txt')).resolves.toBeUndefined();
    });

    it('throws with a clear message when an object is present', async () => {
      const s = service();
      await s.upload('here.txt', 'x');
      await expect(assertMissing(s, 'here.txt')).rejects.toThrow(/assertMissing.*"here\.txt"/);
    });
  });

  describe('assertCount', () => {
    it('passes when the total object count matches', async () => {
      const s = service();
      await s.upload('a', '1');
      await s.upload('b', '2');
      await s.upload('c', '3');
      await expect(assertCount(s, 3)).resolves.toBeUndefined();
    });

    it('throws when the total count is wrong, listing the keys found', async () => {
      const s = service();
      await s.upload('a', '1');
      await s.upload('b', '2');
      await expect(assertCount(s, 5)).rejects.toThrow(/expected 5.*found 2.*a.*b/s);
    });

    it('counts only objects under a given prefix', async () => {
      const s = service();
      await s.upload('users/1', 'x');
      await s.upload('users/2', 'y');
      await s.upload('logs/1', 'z');
      await expect(assertCount(s, 'users/', 2)).resolves.toBeUndefined();
      await expect(assertCount(s, 'logs/', 1)).resolves.toBeUndefined();
    });

    it('throws for a prefix count mismatch, naming the prefix', async () => {
      const s = service();
      await s.upload('users/1', 'x');
      await expect(assertCount(s, 'users/', 3)).rejects.toThrow(
        /expected 3.*prefix "users\/".*found 1/s,
      );
    });

    it('passes with zero for an empty disk', async () => {
      await expect(assertCount(service(), 0)).resolves.toBeUndefined();
    });
  });
});

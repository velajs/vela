import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PresenceService, presenceTag } from '../live/index.js';

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const byteLength = (text: string): number => new TextEncoder().encode(text).byteLength;

// The engine's bound on one invalidation tag.
const MAX_TAG_BYTES = 256;

describe('presenceTag', () => {
  it('names a gateway room by the SHA-256 digest of its path and room id', () => {
    const rooms = [
      ...Array.from({ length: 200 }, (_, index) => 'r'.repeat(index + 1)),
      'sala-ação',
      '🛰️ orbit',
      '€'.repeat(170),
      'w'.repeat(512),
    ];
    for (const path of ['', '/ws', '/workspaces/:workspace/realtime/ws']) {
      for (const room of rooms) {
        expect(presenceTag(path, room)).toBe(
          `$presence:${sha256Hex(JSON.stringify([path, room]))}`,
        );
      }
    }
  });

  it('fits the invalidation tag budget for every valid room on any gateway path', () => {
    const longPath = `/${'segment/'.repeat(64)}:room/ws`;
    for (const room of ['w'.repeat(512), '€'.repeat(170)]) {
      expect(byteLength(presenceTag(longPath, room))).toBeLessThanOrEqual(MAX_TAG_BYTES);
    }
  });

  it('keeps the rooms of different gateways apart', () => {
    expect(presenceTag('/chat', 'org-1')).not.toBe(presenceTag('/admin', 'org-1'));
    expect(presenceTag('/a', 'b/c')).not.toBe(presenceTag('/a/b', 'c'));
  });

  it('rejects invalid room ids', () => {
    expect(() => presenceTag('/ws', '')).toThrow(/room ids/);
    expect(() => presenceTag('/ws', 'w'.repeat(513))).toThrow(/room ids/);
    expect(() => presenceTag('/ws', 'line\nbreak')).toThrow(/room ids/);
  });

  it('invalidates the bounded tag of each gateway room a heartbeat or departure touches', () => {
    const presence = new PresenceService();
    const invalidated: string[][] = [];
    presence.bindInvalidator((tags) => invalidated.push(tags));
    const room = 'w'.repeat(512);

    presence.beat('/ws', room, 'c1');
    presence.beat('/admin', room, 'c1');
    presence.reap('c1');

    const ws = presenceTag('/ws', room);
    const admin = presenceTag('/admin', room);
    expect(invalidated).toEqual([[ws], [admin], [ws], [admin]]);
    expect(presence.roster('/ws', room)).toEqual([]);
  });
});

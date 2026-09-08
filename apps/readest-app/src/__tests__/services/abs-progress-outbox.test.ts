import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyConflict,
  dirtyRows,
  markClean,
  readOutbox,
  removeOutbox,
  upsertOutbox,
  type AbsProgressOutboxRow,
} from '@/services/audiobookshelf/progressOutbox';

const row = (overrides: Partial<AbsProgressOutboxRow> = {}): AbsProgressOutboxRow => ({
  bookHash: 'h1',
  itemId: 'item1',
  localSessionId: 'uuid-1',
  currentTime: 12.5,
  duration: 100,
  timeListening: 3,
  lastPlayedAt: 1000,
  dirty: true,
  serverLastUpdateCached: 500,
  ...overrides,
});

describe('progress outbox', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('upsert overwrites the same item+episode and keeps two episodes as two rows', () => {
    upsertOutbox(row({ currentTime: 1 }));
    upsertOutbox(row({ currentTime: 2.25 }));
    upsertOutbox(row({ episodeId: 'ep1', currentTime: 9, localSessionId: 'uuid-ep' }));

    const all = readOutbox();
    expect(all).toHaveLength(2);
    const book = all.find((r) => !r.episodeId);
    const ep = all.find((r) => r.episodeId === 'ep1');
    expect(book?.currentTime).toBe(2.25);
    expect(ep?.currentTime).toBe(9);
    expect(JSON.parse(localStorage.getItem('readest_abs_progress_outbox') ?? '[]')).toHaveLength(2);
  });

  it('dirtyRows filters clean rows', () => {
    upsertOutbox(row({ dirty: true }));
    upsertOutbox(row({ itemId: 'item2', dirty: false, currentTime: 1 }));
    expect(dirtyRows()).toHaveLength(1);
    expect(dirtyRows()[0]!.itemId).toBe('item1');
  });

  it('markClean clears dirty and drops the local session id', () => {
    upsertOutbox(row());
    markClean('item1');
    const cleaned = readOutbox().find((r) => r.itemId === 'item1');
    expect(cleaned?.dirty).toBe(false);
    expect(cleaned?.localSessionId).toBe('');
    expect(cleaned?.currentTime).toBe(12.5);
  });

  it('removeOutbox deletes the row', () => {
    upsertOutbox(row());
    removeOutbox('item1');
    expect(readOutbox()).toHaveLength(0);
  });
});

describe('classifyConflict', () => {
  it('skips a clean row', () => {
    expect(
      classifyConflict({
        local: row({ dirty: false }),
        server: { currentTime: 99, lastUpdate: 9999 },
      }),
    ).toBe('skip');
  });

  it('pushes when we are the only writer', () => {
    expect(
      classifyConflict({
        local: row({ dirty: true, serverLastUpdateCached: 500, currentTime: 80 }),
        server: { currentTime: 10, lastUpdate: 500 },
      }),
    ).toBe('push');
    expect(
      classifyConflict({
        local: row({ dirty: true, serverLastUpdateCached: 500 }),
        server: { currentTime: 10, lastUpdate: 400 },
      }),
    ).toBe('push');
  });

  it('silent-adopts when server is newer and delta is under 30s', () => {
    expect(
      classifyConflict({
        local: row({ dirty: true, currentTime: 100, serverLastUpdateCached: 500 }),
        server: { currentTime: 110, lastUpdate: 2000 },
      }),
    ).toBe('silent-adopt');
  });

  it('dialogs when server is newer and delta is at least 30s', () => {
    expect(
      classifyConflict({
        local: row({ dirty: true, currentTime: 100, serverLastUpdateCached: 500 }),
        server: { currentTime: 140, lastUpdate: 2000 },
      }),
    ).toBe('dialog');
  });
});

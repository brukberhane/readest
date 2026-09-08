import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppService } from '@/types/system';
import type { Book } from '@/types/book';
import type { ABSServer } from '@/types/audiobookshelf';
import { makeAbsFilePath } from '@/utils/audiobook';
import { useLibraryStore } from '@/store/libraryStore';
import { ABSRequestError } from '@/services/audiobookshelf/client';
import {
  drainAbsProgressOutbox,
  dirtyRows,
  readOutbox,
  setAbsOnScreenItem,
  upsertOutbox,
  type AbsProgressOutboxRow,
} from '@/services/audiobookshelf/progressOutbox';
import { eventDispatcher } from '@/utils/event';
import { readLocalPos } from '@/services/audiobookshelf/progressSync';

const server: ABSServer = {
  id: 'srv1',
  name: 'Home',
  url: 'http://abs.local:13378',
  accessToken: 'token-1',
};

const book: Book = {
  hash: 'h1',
  format: 'ABS',
  filePath: makeAbsFilePath('srv1', 'item1'),
  title: 'Pride',
  author: 'Jane',
  createdAt: 0,
  updatedAt: 0,
};

const row = (overrides: Partial<AbsProgressOutboxRow> = {}): AbsProgressOutboxRow => ({
  bookHash: 'h1',
  itemId: 'item1',
  localSessionId: 'uuid-1',
  currentTime: 80.5,
  duration: 100,
  timeListening: 12,
  lastPlayedAt: 5000,
  dirty: true,
  serverLastUpdateCached: 1000,
  ...overrides,
});

describe('drainAbsProgressOutbox', () => {
  beforeEach(() => {
    localStorage.clear();
    setAbsOnScreenItem(null);
    useLibraryStore.getState().setLibrary([book]);
  });

  it('40 upserts collapse to one row and one syncLocalSession with the last currentTime', async () => {
    const syncLocalSession = vi.fn().mockResolvedValue(undefined);
    const getMe = vi.fn().mockResolvedValue({
      mediaProgress: [{ libraryItemId: 'item1', currentTime: 10, lastUpdate: 1000 }],
    });
    for (let i = 1; i <= 40; i++) {
      upsertOutbox(row({ currentTime: i, timeListening: i, localSessionId: 'uuid-1' }));
    }
    expect(readOutbox()).toHaveLength(1);

    await drainAbsProgressOutbox({} as AppService, {
      getClient: () => ({
        getMe,
        syncLocalSession,
        patchProgress: vi.fn(),
      }),
      getServer: () => server,
    });

    expect(syncLocalSession).toHaveBeenCalledTimes(1);
    expect(syncLocalSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'uuid-1',
        libraryItemId: 'item1',
        currentTime: 40,
        timeListening: 40,
      }),
    );
    expect(dirtyRows()).toHaveLength(0);
  });

  it('falls back to exactly one PATCH on 404, not a second local POST', async () => {
    const syncLocalSession = vi
      .fn()
      .mockRejectedValue(new ABSRequestError(404, '/api/session/local'));
    const patchProgress = vi.fn().mockResolvedValue(undefined);
    upsertOutbox(row());

    await drainAbsProgressOutbox({} as AppService, {
      getClient: () => ({
        getMe: async () => ({
          mediaProgress: [{ libraryItemId: 'item1', currentTime: 10, lastUpdate: 1000 }],
        }),
        syncLocalSession,
        patchProgress,
      }),
      getServer: () => server,
    });

    expect(syncLocalSession).toHaveBeenCalledTimes(1);
    expect(patchProgress).toHaveBeenCalledTimes(1);
    expect(patchProgress).toHaveBeenCalledWith(
      'item1',
      expect.objectContaining({ currentTime: 80.5, duration: 100 }),
      undefined,
    );
    expect(dirtyRows()).toHaveLength(0);
  });

  it('silent-adopt does not call syncLocalSession and writes the server position', async () => {
    const syncLocalSession = vi.fn();
    const toastSpy = vi.spyOn(eventDispatcher, 'dispatch');
    upsertOutbox(row({ currentTime: 100, serverLastUpdateCached: 500 }));

    await drainAbsProgressOutbox({} as AppService, {
      getClient: () => ({
        getMe: async () => ({
          mediaProgress: [
            { libraryItemId: 'item1', currentTime: 110, duration: 100, lastUpdate: 2000 },
          ],
        }),
        syncLocalSession,
        patchProgress: vi.fn(),
      }),
      getServer: () => server,
    });

    expect(syncLocalSession).not.toHaveBeenCalled();
    expect(readLocalPos('h1')).toBe(110);
    expect(dirtyRows()).toHaveLength(0);
    expect(toastSpy).toHaveBeenCalledWith(
      'toast',
      expect.objectContaining({ message: 'Progress updated from server' }),
    );
  });

  it('dialog rows remain dirty and are returned', async () => {
    const syncLocalSession = vi.fn();
    upsertOutbox(row({ currentTime: 100, serverLastUpdateCached: 500 }));

    const result = await drainAbsProgressOutbox({} as AppService, {
      getClient: () => ({
        getMe: async () => ({
          mediaProgress: [
            { libraryItemId: 'item1', currentTime: 140, duration: 100, lastUpdate: 2000 },
          ],
        }),
        syncLocalSession,
        patchProgress: vi.fn(),
      }),
      getServer: () => server,
      onScreen: { itemId: 'item1' },
    });

    expect(syncLocalSession).not.toHaveBeenCalled();
    expect(dirtyRows()).toHaveLength(1);
    expect(result.dialogRows).toHaveLength(1);
    expect(result.dialogRows[0]!.local.itemId).toBe('item1');
    expect(result.dialogRows[0]!.server.currentTime).toBe(140);
  });

  it('background dialog rows silent-adopt when onScreen does not match', async () => {
    const syncLocalSession = vi.fn();
    upsertOutbox(row({ currentTime: 100, serverLastUpdateCached: 500 }));

    const result = await drainAbsProgressOutbox({} as AppService, {
      getClient: () => ({
        getMe: async () => ({
          mediaProgress: [
            { libraryItemId: 'item1', currentTime: 140, duration: 100, lastUpdate: 2000 },
          ],
        }),
        syncLocalSession,
        patchProgress: vi.fn(),
      }),
      getServer: () => server,
      onScreen: { itemId: 'other', episodeId: undefined },
    });

    expect(syncLocalSession).not.toHaveBeenCalled();
    expect(result.dialogRows).toHaveLength(0);
    expect(dirtyRows()).toHaveLength(0);
    expect(readLocalPos('h1')).toBe(140);
  });

  it('registered on-screen item is treated as dialog even when onScreen is omitted', async () => {
    const syncLocalSession = vi.fn();
    setAbsOnScreenItem({ itemId: 'item1' });
    upsertOutbox(row({ currentTime: 100, serverLastUpdateCached: 500 }));

    const result = await drainAbsProgressOutbox({} as AppService, {
      getClient: () => ({
        getMe: async () => ({
          mediaProgress: [
            { libraryItemId: 'item1', currentTime: 140, duration: 100, lastUpdate: 2000 },
          ],
        }),
        syncLocalSession,
        patchProgress: vi.fn(),
      }),
      getServer: () => server,
    });

    expect(syncLocalSession).not.toHaveBeenCalled();
    expect(dirtyRows()).toHaveLength(1);
    expect(result.dialogRows).toHaveLength(1);
  });
});

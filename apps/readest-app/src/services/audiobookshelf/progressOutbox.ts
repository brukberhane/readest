import type { AppService } from '@/types/system';
import type { ABSServer } from '@/types/audiobookshelf';
import { ABSAuthError, ABSRequestError } from '@/services/audiobookshelf/client';
import { createAbsClient } from '@/services/audiobookshelf/createClient';
import { findABSServerById } from '@/store/absServerStore';
import { useLibraryStore } from '@/store/libraryStore';
import { parseAbsFilePath } from '@/utils/audiobook';
import { eventDispatcher } from '@/utils/event';
import { stubTranslation as _ } from '@/utils/misc';

export interface AbsProgressOutboxRow {
  bookHash: string;
  itemId: string;
  episodeId?: string;
  localSessionId: string;
  currentTime: number;
  duration: number;
  timeListening: number;
  lastPlayedAt: number;
  dirty: boolean;
  serverLastUpdateCached?: number;
}

export type AbsConflictClass = 'push' | 'silent-adopt' | 'dialog' | 'skip';

export interface AbsProgressConflict {
  local: AbsProgressOutboxRow;
  server: { currentTime: number; lastUpdate: number; duration: number };
}

const OUTBOX_KEY = 'readest_abs_progress_outbox';

const rowKey = (itemId: string, episodeId?: string): string => `${itemId}\0${episodeId || ''}`;

const matches = (row: AbsProgressOutboxRow, itemId: string, episodeId?: string): boolean =>
  row.itemId === itemId && (row.episodeId || '') === (episodeId || '');

export const readOutbox = (): AbsProgressOutboxRow[] => {
  try {
    const raw = localStorage.getItem(OUTBOX_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AbsProgressOutboxRow[]) : [];
  } catch {
    return [];
  }
};

const writeOutbox = (rows: AbsProgressOutboxRow[]): void => {
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(rows));
};

export const upsertOutbox = (row: AbsProgressOutboxRow): AbsProgressOutboxRow => {
  const rows = readOutbox();
  const key = rowKey(row.itemId, row.episodeId);
  const next = rows.filter((existing) => rowKey(existing.itemId, existing.episodeId) !== key);
  next.push(row);
  writeOutbox(next);
  return row;
};

export const dirtyRows = (): AbsProgressOutboxRow[] => readOutbox().filter((row) => row.dirty);

export const markClean = (itemId: string, episodeId?: string): void => {
  writeOutbox(
    readOutbox().map((row) =>
      matches(row, itemId, episodeId)
        ? { ...row, dirty: false, localSessionId: '', timeListening: 0 }
        : row,
    ),
  );
};

export const removeOutbox = (itemId: string, episodeId?: string): void => {
  writeOutbox(readOutbox().filter((row) => !matches(row, itemId, episodeId)));
};

export const findOutboxRow = (
  itemId: string,
  episodeId?: string,
): AbsProgressOutboxRow | undefined => readOutbox().find((row) => matches(row, itemId, episodeId));

const localPosKey = (bookHash: string, episodeId?: string): string =>
  episodeId ? `abs-local-pos-${bookHash}:${episodeId}` : `abs-local-pos-${bookHash}`;

export const readLocalPos = (bookHash: string, episodeId?: string): number => {
  try {
    const raw = localStorage.getItem(localPosKey(bookHash, episodeId));
    return raw != null && raw !== '' ? Number(raw) || 0 : 0;
  } catch {
    return 0;
  }
};

export const writeLocalPos = (bookHash: string, currentTime: number, episodeId?: string): void => {
  try {
    localStorage.setItem(localPosKey(bookHash, episodeId), String(currentTime));
  } catch (err) {
    console.warn(err);
  }
};

export const classifyConflict = (input: {
  local: AbsProgressOutboxRow;
  server: { currentTime: number; lastUpdate: number };
}): AbsConflictClass => {
  if (!input.local.dirty) return 'skip';
  const cached = input.local.serverLastUpdateCached ?? 0;
  if (input.server.lastUpdate <= cached) return 'push';
  const delta = Math.abs(input.server.currentTime - input.local.currentTime);
  return delta < 30 ? 'silent-adopt' : 'dialog';
};

export interface AbsDrainClient {
  getMe: () => Promise<{
    mediaProgress: Array<{
      libraryItemId: string;
      episodeId?: string | null;
      currentTime: number;
      duration?: number;
      lastUpdate: number;
    }>;
  }>;
  syncLocalSession: (session: {
    id: string;
    libraryItemId: string;
    episodeId?: string;
    currentTime: number;
    duration: number;
    timeListening: number;
    startedAt: number;
    updatedAt: number;
  }) => Promise<void>;
  patchProgress: (
    libraryItemId: string,
    payload: { currentTime: number; duration: number; progress: number },
    episodeId?: string,
  ) => Promise<void>;
}

export interface DrainAbsProgressDeps {
  getClient?: (server: ABSServer) => AbsDrainClient;
  getServer?: (serverId: string) => ABSServer | undefined;
  onScreen?: { itemId: string; episodeId?: string };
}

export type AbsOnScreenItem = { itemId: string; episodeId?: string };

let registeredOnScreen: AbsOnScreenItem | null = null;

export const setAbsOnScreenItem = (item: AbsOnScreenItem | null): void => {
  registeredOnScreen = item;
};

const isOnScreen = (row: AbsProgressOutboxRow, onScreen?: AbsOnScreenItem): boolean => {
  const screen = onScreen ?? registeredOnScreen ?? undefined;
  if (!screen) return false;
  return screen.itemId === row.itemId && (screen.episodeId || '') === (row.episodeId || '');
};

const serverProgressFor = (
  me: Awaited<ReturnType<AbsDrainClient['getMe']>>,
  row: AbsProgressOutboxRow,
): { currentTime: number; duration: number; lastUpdate: number } => {
  const match = me.mediaProgress.find(
    (entry) =>
      entry.libraryItemId === row.itemId && (entry.episodeId || '') === (row.episodeId || ''),
  );
  return {
    currentTime: match?.currentTime ?? 0,
    duration: match?.duration ?? row.duration,
    lastUpdate: match?.lastUpdate ?? 0,
  };
};

const applySilentAdopt = (
  row: AbsProgressOutboxRow,
  serverCurrentTime: number,
  duration: number,
): void => {
  writeLocalPos(row.bookHash, serverCurrentTime, row.episodeId);
  const { library, setLibrary } = useLibraryStore.getState();
  const idx = library.findIndex((book) => book.hash === row.bookHash);
  if (idx !== -1) {
    const book = library[idx]!;
    const next = library.slice();
    next[idx] = {
      ...book,
      progress: [Math.round(serverCurrentTime), Math.round(duration)],
    };
    setLibrary(next);
  }
  markClean(row.itemId, row.episodeId);
};

export const drainAbsProgressOutbox = async (
  appService: AppService,
  deps?: DrainAbsProgressDeps,
): Promise<{ dialogRows: AbsProgressConflict[] }> => {
  const getServer = deps?.getServer ?? ((serverId: string) => findABSServerById(serverId));
  const getClient = deps?.getClient ?? ((server: ABSServer) => createAbsClient(appService, server));
  const dialogRows: AbsProgressConflict[] = [];
  let toastedSilentAdopt = false;

  const rows = dirtyRows();
  const clientByServer = new Map<string, AbsDrainClient>();
  const meByServer = new Map<string, Awaited<ReturnType<AbsDrainClient['getMe']>>>();

  const resolveServerId = (row: AbsProgressOutboxRow): string | undefined => {
    const book = useLibraryStore.getState().library.find((b) => b.hash === row.bookHash);
    const parsed = parseAbsFilePath(book?.filePath);
    return parsed?.serverId;
  };

  try {
    for (const row of rows) {
      const serverId = resolveServerId(row);
      const server = serverId ? getServer(serverId) : undefined;
      if (!server) continue;
      if (!clientByServer.has(server.id)) {
        const client = getClient(server);
        clientByServer.set(server.id, client);
        meByServer.set(server.id, await client.getMe());
      }
    }
  } catch (err) {
    if (err instanceof ABSAuthError) return { dialogRows };
    // getMe network failure: leave all dirty
    return { dialogRows };
  }

  for (const row of rows) {
    const serverId = resolveServerId(row);
    const server = serverId ? getServer(serverId) : undefined;
    if (!server) continue;
    const client = clientByServer.get(server.id);
    const me = meByServer.get(server.id);
    if (!client || !me) continue;

    const serverProgress = serverProgressFor(me, row);
    const cls = classifyConflict({ local: row, server: serverProgress });
    if (cls === 'skip') continue;

    if (cls === 'dialog' && isOnScreen(row, deps?.onScreen)) {
      dialogRows.push({ local: row, server: serverProgress });
      continue;
    }
    if (cls === 'silent-adopt' || cls === 'dialog') {
      applySilentAdopt(row, serverProgress.currentTime, serverProgress.duration);
      if (!toastedSilentAdopt) {
        toastedSilentAdopt = true;
        eventDispatcher.dispatch('toast', {
          message: _('Progress updated from server'),
          type: 'info',
        });
      }
      continue;
    }

    try {
      await client.syncLocalSession({
        id: row.localSessionId,
        libraryItemId: row.itemId,
        episodeId: row.episodeId,
        currentTime: row.currentTime,
        duration: row.duration,
        timeListening: row.timeListening,
        startedAt: Math.max(0, row.lastPlayedAt - Math.round(row.timeListening * 1000)),
        updatedAt: row.lastPlayedAt,
      });
      markClean(row.itemId, row.episodeId);
    } catch (err) {
      if (err instanceof ABSAuthError) return { dialogRows };
      if (err instanceof ABSRequestError && (err.status === 404 || err.status === 405)) {
        try {
          await client.patchProgress(
            row.itemId,
            {
              currentTime: row.currentTime,
              duration: row.duration,
              progress: row.duration > 0 ? row.currentTime / row.duration : 0,
            },
            row.episodeId,
          );
          markClean(row.itemId, row.episodeId);
        } catch (patchErr) {
          if (patchErr instanceof ABSAuthError) return { dialogRows };
          // leave dirty
        }
      }
      // network error: leave dirty, continue
    }
  }

  return { dialogRows };
};

export const keepServerProgress = (conflict: AbsProgressConflict): void => {
  applySilentAdopt(conflict.local, conflict.server.currentTime, conflict.server.duration);
};

export const keepDeviceProgress = async (
  conflict: AbsProgressConflict,
  client: AbsDrainClient,
): Promise<void> => {
  const row = conflict.local;
  try {
    await client.syncLocalSession({
      id: row.localSessionId,
      libraryItemId: row.itemId,
      episodeId: row.episodeId,
      currentTime: row.currentTime,
      duration: row.duration,
      timeListening: row.timeListening,
      startedAt: Math.max(0, row.lastPlayedAt - Math.round(row.timeListening * 1000)),
      updatedAt: row.lastPlayedAt,
    });
    markClean(row.itemId, row.episodeId);
  } catch (err) {
    if (err instanceof ABSRequestError && (err.status === 404 || err.status === 405)) {
      await client.patchProgress(
        row.itemId,
        {
          currentTime: row.currentTime,
          duration: row.duration,
          progress: row.duration > 0 ? row.currentTime / row.duration : 0,
        },
        row.episodeId,
      );
      markClean(row.itemId, row.episodeId);
      return;
    }
    throw err;
  }
};

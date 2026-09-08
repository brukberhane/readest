// Progress sync for ABS-backed audiobooks: opens/keeps a server listening
// session in step with playback, applies the newest-wins resume rule when a
// book is opened, and caches progress locally (in the library store and on
// disk, throttled) so the reader shows fresh progress even before the next
// server round-trip lands.

import type { ABSClient } from '@/services/audiobookshelf/client';
import { ABSAuthError } from '@/services/audiobookshelf/client';
import type { AudiobookProgressHooks } from '@/services/audiobook/AudiobookController';
import type { AppService } from '@/types/system';
import type { Book } from '@/types/book';
import { useLibraryStore } from '@/store/libraryStore';
import {
  findOutboxRow,
  upsertOutbox,
  writeLocalPos,
  type AbsProgressOutboxRow,
} from '@/services/audiobookshelf/progressOutbox';

// Mirrors TTSSessionManager's PERSIST_THROTTLE_MS pattern: the in-memory
// library store is updated on every hook so the UI stays current, but the
// disk write it triggers is throttled to this interval.
const PERSIST_THROTTLE_MS = 10_000;

// A tick fires ~every 15s; cap the reported listened time so a missed tick
// (background/suspend) doesn't get credited with the whole gap.
const MAX_LISTENED_SEC = 60;

/**
 * Normalizes an episodeId so `undefined`, `null`, and `''` are all treated
 * as "no episode" (book-level) by one consistent rule, shared by the ctor,
 * the mediaProgress matcher below, and (independently) the client's play
 * path — see ABSClient#openPlaybackSession.
 */
const normalizeEpisodeId = (episodeId?: string | null): string | undefined =>
  episodeId || undefined;

/**
 * localStorage key for a book's (or podcast episode's) last-played-locally
 * timestamp. The `episodeId` suffix keeps every episode's cache isolated
 * even if two episodes ever end up sharing a `bookHash`, and leaves the book
 * key format (no suffix) unchanged for backward compatibility with
 * already-cached books. The `:` delimiter is unambiguous because ABS book
 * hashes are 32-char lowercase hex md5 digests, which can never contain `:`.
 */
const lastPlayedAtKey = (bookHash: string, episodeId?: string): string => {
  const normalized = normalizeEpisodeId(episodeId);
  return normalized ? `abs-last-played-${bookHash}:${normalized}` : `abs-last-played-${bookHash}`;
};

/**
 * When this device last wrote progress for `bookHash` (and, for a podcast
 * episode, `episodeId`), in ms (0 when never). Written by
 * AbsProgressSyncer#cacheLocally; read by the resume rule and by the library
 * sync's newest-wins guard.
 */
export const readLocalLastPlayedAt = (bookHash: string, episodeId?: string): number => {
  try {
    const raw = localStorage.getItem(lastPlayedAtKey(bookHash, episodeId));
    return raw ? Number(raw) || 0 : 0;
  } catch {
    return 0;
  }
};

export { readLocalPos, writeLocalPos } from '@/services/audiobookshelf/progressOutbox';

/**
 * The single newest-wins comparison for ABS progress: local wins only when
 * it is strictly newer, so the server wins ties. Every place that chooses
 * between a local and a server position goes through this — the resume rule
 * below and `reconcileAbsBooks` — so a paused book can't have its fresh local
 * position clobbered by one code path and honored by the other.
 */
export const isLocalProgressFresher = (
  localLastPlayedAt: number,
  serverLastUpdate: number,
): boolean => localLastPlayedAt > serverLastUpdate;

/** Pure resume rule, exported for tests: newest wins, server wins ties. */
export const resolveResumePosition = (input: {
  serverCurrentTime: number; // from the freshly opened playback session
  serverLastUpdate: number; // ms, from mediaProgress (0 when absent)
  localCurrentTime: number; // cached Book.progress[0] (0 when absent)
  localLastPlayedAt: number; // ms (0 when absent)
}): number =>
  isLocalProgressFresher(input.localLastPlayedAt, input.serverLastUpdate)
    ? input.localCurrentTime
    : input.serverCurrentTime;

export class AbsProgressSyncer {
  #client: ABSClient;
  #itemId: string;
  #episodeId?: string;
  #bookHash: string;
  #duration: number;
  #appService: AppService;
  #sessionId: string | null = null;
  #lastSyncedPosition = 0;
  #lastPersistAt = 0;
  #closed = false;

  constructor(input: {
    client: ABSClient;
    itemId: string;
    episodeId?: string;
    bookHash: string;
    duration: number;
    appService: AppService;
  }) {
    this.#client = input.client;
    this.#itemId = input.itemId;
    this.#episodeId = normalizeEpisodeId(input.episodeId);
    this.#bookHash = input.bookHash;
    this.#duration = input.duration;
    this.#appService = input.appService;
  }

  /**
   * Open the server listening session; returns the resume position honoring
   * resolveResumePosition. When the device is offline, skips the network and
   * returns the local float position instead.
   */
  async begin(
    localCurrentTime: number,
    localLastPlayedAt: number,
    opts?: { offline?: boolean },
  ): Promise<number> {
    const skipNetwork =
      (typeof navigator !== 'undefined' && navigator.onLine === false) ||
      (opts?.offline === true && typeof navigator !== 'undefined' && navigator.onLine === false);
    if (skipNetwork) {
      this.#sessionId = null;
      this.#lastSyncedPosition = localCurrentTime;
      return localCurrentTime;
    }

    try {
      const [session, me] = await Promise.all([
        this.#client.openPlaybackSession(this.#itemId, this.#episodeId),
        this.#client.getMe(),
      ]);
      this.#sessionId = session.id;
      // Match on (libraryItemId, episodeId) together, normalizing both sides
      // through normalizeEpisodeId: a book (no episodeId) refuses to match a
      // show-level or other-episode entry, and an episode refuses to match
      // its show's book-level entry. An explicit `episodeId: null` on the
      // mediaProgress entry (the book case, per /api/me) normalizes to
      // `undefined` the same as an absent field.
      const progress = me.mediaProgress.find(
        (p) =>
          p.libraryItemId === this.#itemId && normalizeEpisodeId(p.episodeId) === this.#episodeId,
      );
      const serverLastUpdate = progress?.lastUpdate ?? 0;
      const resume = resolveResumePosition({
        serverCurrentTime: session.currentTime,
        serverLastUpdate,
        localCurrentTime,
        localLastPlayedAt,
      });
      this.#lastSyncedPosition = resume;
      this.#seedFromServer({
        serverCurrentTime: session.currentTime,
        serverLastUpdate,
        localCurrentTime,
        localLastPlayedAt,
      });
      return resume;
    } catch (err) {
      if (err instanceof ABSAuthError) throw err;
      this.#sessionId = null;
      this.#lastSyncedPosition = localCurrentTime;
      return localCurrentTime;
    }
  }

  /** Wire into AudiobookController: returns hooks that sync + cache locally. */
  hooks(): AudiobookProgressHooks {
    return {
      // Pause is a natural quit point (the user may kill the app right
      // after), so it force-flushes the local cache to disk the same as
      // onEnd, bypassing the throttle below.
      onPause: (pos) => this.#syncListened(pos, true),
      onTick: (pos) => this.#syncListened(pos, false),
      onSeek: (pos) => this.#syncSeek(pos),
      onEnd: (pos) => this.#end(pos),
    };
  }

  #syncListened(pos: number, force: boolean): void {
    const timeListened = Math.min(MAX_LISTENED_SEC, Math.max(0, pos - this.#lastSyncedPosition));
    this.#lastSyncedPosition = pos;
    this.#cacheLocally(pos, force);
    this.#syncSession(pos, timeListened);
  }

  #syncSeek(pos: number): void {
    this.#lastSyncedPosition = pos;
    this.#cacheLocally(pos, false);
    this.#syncSession(pos, 0);
  }

  #end(pos: number): void {
    if (this.#closed) return;
    this.#closed = true;
    const timeListened = Math.min(MAX_LISTENED_SEC, Math.max(0, pos - this.#lastSyncedPosition));
    this.#lastSyncedPosition = pos;
    // Unconditional flush: onEnd is the last chance to persist before the
    // app may be killed, so it must not be silently dropped by the throttle
    // (see task review — pause-then-kill within the throttle window would
    // otherwise regress the resume position on next open).
    this.#cacheLocally(pos, true);
    if (this.#sessionId) {
      this.#client
        .closeSession(this.#sessionId, { currentTime: pos, timeListened, duration: this.#duration })
        .then(() => this.#persistCleanRow(pos))
        .catch(console.warn);
    } else {
      this.#enqueueDirty(pos, timeListened);
    }
  }

  #syncSession(pos: number, timeListened: number): void {
    if (!this.#sessionId) {
      this.#enqueueDirty(pos, timeListened);
      return;
    }
    this.#client
      .syncSession(this.#sessionId, { currentTime: pos, timeListened, duration: this.#duration })
      .then(() => this.#persistCleanRow(pos))
      .catch((err: unknown) => {
        console.warn(err);
        this.#enqueueDirty(pos, timeListened);
      });
  }

  #seedFromServer(input: {
    serverCurrentTime: number;
    serverLastUpdate: number;
    localCurrentTime: number;
    localLastPlayedAt: number;
  }): void {
    const localWins = isLocalProgressFresher(input.localLastPlayedAt, input.serverLastUpdate);
    if (!localWins) {
      writeLocalPos(this.#bookHash, input.serverCurrentTime, this.#episodeId);
    }
    const existing = findOutboxRow(this.#itemId, this.#episodeId);
    const currentTime = localWins
      ? (existing?.currentTime ?? input.localCurrentTime)
      : input.serverCurrentTime;
    upsertOutbox(
      this.#rowFromExisting(existing, currentTime, {
        serverLastUpdateCached: input.serverLastUpdate,
      }),
    );
  }

  #persistCleanRow(pos: number): void {
    const existing = findOutboxRow(this.#itemId, this.#episodeId);
    upsertOutbox({
      ...this.#rowFromExisting(existing, pos, {
        dirty: false,
        localSessionId: '',
        timeListening: 0,
      }),
    });
  }

  #enqueueDirty(pos: number, timeListened: number): void {
    const existing = findOutboxRow(this.#itemId, this.#episodeId);
    const reuseId = existing?.dirty && existing.localSessionId ? existing.localSessionId : '';
    const localSessionId = reuseId || crypto.randomUUID();
    const timeListening = (existing?.dirty ? existing.timeListening : 0) + timeListened;
    upsertOutbox(
      this.#rowFromExisting(existing, pos, {
        dirty: true,
        localSessionId,
        timeListening,
        lastPlayedAt: Date.now(),
      }),
    );
  }

  #rowFromExisting(
    existing: AbsProgressOutboxRow | undefined,
    currentTime: number,
    overrides: Partial<AbsProgressOutboxRow>,
  ): AbsProgressOutboxRow {
    const row: AbsProgressOutboxRow = {
      bookHash: this.#bookHash,
      itemId: this.#itemId,
      localSessionId: existing?.localSessionId ?? '',
      currentTime,
      duration: this.#duration,
      timeListening: existing?.timeListening ?? 0,
      lastPlayedAt: existing?.lastPlayedAt ?? Date.now(),
      dirty: existing?.dirty ?? false,
      serverLastUpdateCached: existing?.serverLastUpdateCached,
      ...overrides,
    };
    if (this.#episodeId) row.episodeId = this.#episodeId;
    return row;
  }

  // Updates the library book's cached progress and, throttled, persists the
  // library to disk. Reads the current library at write time and produces a
  // new array with a new book object rather than mutating any store-held
  // book in place, so this never clobbers concurrent library changes.
  // `force` bypasses the throttle for the points where a dropped write would
  // regress the resume position (pause, end) rather than just being a stale
  // intermediate tick.
  #cacheLocally(pos: number, force: boolean): void {
    writeLocalPos(this.#bookHash, pos, this.#episodeId);

    const { library, setLibrary } = useLibraryStore.getState();
    const idx = library.findIndex((b) => b.hash === this.#bookHash);
    if (idx !== -1) {
      const book = library[idx]!;
      const now = Date.now();
      const progress: [number, number] = [Math.round(pos), Math.round(this.#duration)];
      // Bump updatedAt so Date Read sorting reflects listening activity, the
      // same way the reader's progress saves do for regular books. Reconcile
      // never compares updatedAt, so this cannot cause sync churn.
      const updatedBook: Book = { ...book, progress, updatedAt: now };
      const newLibrary = library.slice();
      newLibrary[idx] = updatedBook;
      setLibrary(newLibrary);

      if (force || now - this.#lastPersistAt >= PERSIST_THROTTLE_MS) {
        this.#lastPersistAt = now;
        Promise.resolve(this.#appService.saveLibraryBooks(newLibrary)).catch(console.warn);
      }
    }

    try {
      localStorage.setItem(lastPlayedAtKey(this.#bookHash, this.#episodeId), String(Date.now()));
    } catch (err) {
      // Best-effort: a book still plays fine without the local resume cache.
      console.warn(err);
    }
  }
}

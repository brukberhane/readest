import type { AppService } from '@/types/system';
import type { Book } from '@/types/book';
import type {
  ABSEpisode,
  ABSLibraryItem,
  ABSMediaProgress,
  ABSServer,
  ABSTrack,
} from '@/types/audiobookshelf';
import { parseAbsFilePath } from '@/utils/audiobook';
import { eventDispatcher } from '@/utils/event';
import { stubTranslation as _ } from '@/utils/misc';
import {
  absMediaJobId,
  useAbsMediaStore,
  type AbsMediaJob,
  type AbsMediaPresence,
} from '@/store/absMediaStore';
import {
  deleteAbsMedia,
  mergeAbsSnapshot,
  snapshotFromExpanded,
  snapshotIsComplete,
  type AbsPlaybackSnapshot,
  type AbsSnapshotTrack,
  writeSnapshot as writeSnapshotToDisk,
  readSnapshot as readSnapshotFromDisk,
} from '@/services/audiobookshelf/playbackSnapshot';
import { findOutboxRow, upsertOutbox } from '@/services/audiobookshelf/progressOutbox';
import {
  isLocalProgressFresher,
  readLocalLastPlayedAt,
  writeLocalPos,
} from '@/services/audiobookshelf/progressSync';

export type AbsTrackDownloader = (input: {
  url: string;
  destAbsPath: string;
  headers: Record<string, string>;
  onProgress: (p: { progress: number; total?: number }) => void;
  signal?: AbortSignal;
}) => Promise<void>;

export interface AbsDownloadClient {
  getItemExpanded: (itemId: string) => Promise<ABSLibraryItem>;
  getMe: () => Promise<{ mediaProgress: ABSMediaProgress[] }>;
  downloadUrlForTrack: (
    itemId: string,
    track: Pick<ABSTrack, 'contentUrl' | 'index'> & { ino?: string },
  ) => string;
}

const QUEUE_KEY = 'readest_abs_media_queue';
const INDEX_KEY = 'readest_abs_media_index';
const QUEUE_SCHEMA_VERSION = 1;

interface PersistedQueueData {
  schemaVersion?: number;
  items: Record<string, AbsMediaJob>;
}

const isAbortError = (err: unknown): boolean =>
  (err instanceof DOMException && err.name === 'AbortError') ||
  (err instanceof Error && err.name === 'AbortError');

const snapshotForEpisode = (
  item: ABSLibraryItem,
  book: Book,
  episode: ABSEpisode,
): AbsPlaybackSnapshot => {
  const tracks = episode.audioTrack ? [episode.audioTrack] : [];
  return snapshotFromExpanded(
    {
      ...item,
      media: {
        ...item.media,
        tracks,
        chapters: episode.chapters ?? [],
        duration: episode.duration ?? episode.audioTrack?.duration,
      },
    },
    book.hash,
    {
      title: episode.title,
      author: item.media.metadata.title || book.author,
      episodeId: episode.id,
    },
  );
};

export interface AbsMediaDownloadDeps {
  downloadTrack: AbsTrackDownloader;
  resolveAbsPath: (rel: string) => Promise<string>;
  exists: AppService['exists'];
  stats: AppService['stats'];
  createDir: AppService['createDir'];
  deleteFile: AppService['deleteFile'];
  deleteDir: AppService['deleteDir'];
  copyFile: AppService['copyFile'];
  writeSnapshot: typeof writeSnapshotToDisk;
  readSnapshot: typeof readSnapshotFromDisk;
  isTauri: () => boolean;
  getClient: (server: ABSServer) => AbsDownloadClient;
  getServer: (serverId: string) => ABSServer | undefined;
}

export class AbsMediaDownloadManager {
  #deps: AbsMediaDownloadDeps;
  #active: { id: string; abort: AbortController } | null = null;
  #processing = false;
  #loaded = false;
  #appService: AppService | null = null;

  constructor(deps: AbsMediaDownloadDeps) {
    this.#deps = deps;
  }

  async queueBook(input: { appService: AppService; book: Book }): Promise<void> {
    this.#ensureLoaded();
    if (!this.#deps.isTauri()) {
      this.#webToast();
      return;
    }
    const parsed = parseAbsFilePath(input.book.filePath);
    const server = parsed ? this.#deps.getServer(parsed.serverId) : undefined;
    if (!parsed || !server) return;
    this.#appService = input.appService;
    const client = this.#deps.getClient(server);
    const item = await client.getItemExpanded(parsed.itemId);
    await this.#seedProgress(client, input.book.hash, parsed.itemId);
    const fresh = snapshotFromExpanded(item, input.book.hash, {
      title: input.book.title,
      author: input.book.author,
    });
    const existing = await this.#deps.readSnapshot(input.appService, input.book.hash);
    await this.#deps.writeSnapshot(input.appService, mergeAbsSnapshot(fresh, existing));
    this.#enqueue({
      bookHash: input.book.hash,
      itemId: parsed.itemId,
      serverId: parsed.serverId,
      label: input.book.title,
    });
    this.#persistQueue();
    await this.#processQueue();
  }

  async queueEpisode(input: {
    appService: AppService;
    book: Book;
    episode: ABSEpisode;
  }): Promise<void> {
    this.#ensureLoaded();
    if (!this.#deps.isTauri()) {
      this.#webToast();
      return;
    }
    const parsed = parseAbsFilePath(input.book.filePath);
    const server = parsed ? this.#deps.getServer(parsed.serverId) : undefined;
    if (!parsed || !server) return;
    this.#appService = input.appService;
    const client = this.#deps.getClient(server);
    const item = await client.getItemExpanded(parsed.itemId);
    await this.#seedProgress(client, input.book.hash, parsed.itemId, input.episode.id);
    const fresh = snapshotForEpisode(item, input.book, input.episode);
    const existing = await this.#deps.readSnapshot(
      input.appService,
      input.book.hash,
      input.episode.id,
    );
    await this.#deps.writeSnapshot(input.appService, mergeAbsSnapshot(fresh, existing));
    this.#enqueue({
      bookHash: input.book.hash,
      episodeId: input.episode.id,
      itemId: parsed.itemId,
      serverId: parsed.serverId,
      label: input.episode.title,
    });
    this.#persistQueue();
    await this.#processQueue();
  }

  cancel(id: string): void {
    this.#ensureLoaded();
    if (this.#active?.id === id) this.#active.abort.abort();
    useAbsMediaStore.getState().removeItem(id);
    this.#persistQueue();
  }

  async removeDownload(input: {
    appService: AppService;
    bookHash: string;
    episodeId?: string;
  }): Promise<void> {
    this.#ensureLoaded();
    const id = absMediaJobId(input.bookHash, input.episodeId);
    this.cancel(id);
    await deleteAbsMedia(input.appService, input.bookHash, input.episodeId);
    useAbsMediaStore.getState().setPresence(id, {
      bookHash: input.bookHash,
      ...(input.episodeId ? { episodeId: input.episodeId } : {}),
      complete: false,
      bytes: 0,
    });
    this.#persistIndex();
  }

  #webToast(): void {
    eventDispatcher.dispatch('toast', {
      message: _('Offline playback is only available in the desktop and mobile apps'),
      type: 'info',
    });
  }

  #enqueue(input: {
    bookHash: string;
    episodeId?: string;
    itemId: string;
    serverId: string;
    label: string;
  }): void {
    const store = useAbsMediaStore.getState();
    const existing = store.itemOf(input.bookHash, input.episodeId);
    if (existing?.status === 'pending' || existing?.status === 'in_progress') return;
    if (existing?.status === 'failed') store.removeItem(existing.id);
    store.enqueue(input);
  }

  async #processQueue(): Promise<void> {
    if (this.#processing) return;
    this.#processing = true;
    try {
      for (;;) {
        const store = useAbsMediaStore.getState();
        const next = Object.values(store.items)
          .filter((item) => item.status === 'pending')
          .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt)[0];
        if (!next) break;
        await this.#execute(next);
      }
    } finally {
      this.#processing = false;
    }
  }

  async #execute(job: AbsMediaJob): Promise<void> {
    const appService = this.#appService;
    if (!appService) return;
    const store = useAbsMediaStore.getState();
    if (!store.items[job.id] || store.items[job.id]?.status !== 'pending') return;
    store.setInProgress(job.id);
    this.#persistQueue();

    const abort = new AbortController();
    this.#active = { id: job.id, abort };
    try {
      const snapshot = await this.#deps.readSnapshot(appService, job.bookHash, job.episodeId);
      if (!snapshot) throw new Error('Missing snapshot');
      const server = this.#deps.getServer(job.serverId);
      if (!server) throw new Error('Audiobookshelf server not found');
      const client = this.#deps.getClient(server);
      const totalKnown = snapshot.tracks.reduce((sum, track) => sum + (track.size ?? 0), 0);
      let completedBytes = snapshot.tracks
        .filter((track) => track.complete)
        .reduce((sum, track) => sum + (track.size ?? 0), 0);
      let doneTracks = snapshot.tracks.filter((track) => track.complete).length;

      for (const track of snapshot.tracks) {
        if (track.complete) continue;
        if (abort.signal.aborted || !useAbsMediaStore.getState().items[job.id]) return;
        await this.#downloadOneTrack({
          job,
          track,
          snapshot,
          client,
          server,
          appService,
          signal: abort.signal,
          totalKnown,
          completedBytes,
          doneTracks,
        });
        const updated = snapshot.tracks.find((t) => t.fileId === track.fileId);
        completedBytes += updated?.size ?? track.size ?? 0;
        doneTracks += 1;
        if (totalKnown > 0) {
          store.updateProgress(job.id, completedBytes, totalKnown);
        } else {
          store.updateProgress(job.id, doneTracks, 0);
        }
      }

      if (abort.signal.aborted || !useAbsMediaStore.getState().items[job.id]) return;
      const finalSnap = await this.#deps.readSnapshot(appService, job.bookHash, job.episodeId);
      const complete = !!finalSnap && snapshotIsComplete(finalSnap);
      const bytes = (finalSnap?.tracks ?? []).reduce(
        (sum, track) => sum + (track.size ?? 0),
        completedBytes,
      );
      const presence: AbsMediaPresence = {
        bookHash: job.bookHash,
        ...(job.episodeId ? { episodeId: job.episodeId } : {}),
        complete,
        bytes,
      };
      store.setPresence(job.id, presence);
      this.#persistIndex();
      if (complete) {
        store.removeItem(job.id);
        this.#persistQueue();
      } else {
        store.setFailed(job.id, 'Download incomplete');
        this.#persistQueue();
      }
    } catch (err) {
      if (isAbortError(err) || !useAbsMediaStore.getState().items[job.id]) return;
      useAbsMediaStore
        .getState()
        .setFailed(job.id, err instanceof Error ? err.message : String(err));
      this.#persistQueue();
    } finally {
      if (this.#active?.id === job.id) this.#active = null;
    }
  }

  async #downloadOneTrack(input: {
    job: AbsMediaJob;
    track: AbsSnapshotTrack;
    snapshot: AbsPlaybackSnapshot;
    client: AbsDownloadClient;
    server: ABSServer;
    appService: AppService;
    signal: AbortSignal;
    totalKnown: number;
    completedBytes: number;
    doneTracks: number;
  }): Promise<void> {
    const { job, track, snapshot, client, server, appService, signal, totalKnown, completedBytes } =
      input;
    const partRel = `${track.relPath}.part`;
    const destAbsPath = await this.#deps.resolveAbsPath(partRel);
    const url = client.downloadUrlForTrack(job.itemId, {
      contentUrl: track.contentUrl,
      index: track.index,
      ino: track.fileId,
    });
    const headers: Record<string, string> = {
      Accept: 'audio/*,*/*',
      ...(server.accessToken ? { Authorization: `Bearer ${server.accessToken}` } : {}),
    };
    try {
      await this.#deps.createDir(
        track.relPath.includes('/') ? track.relPath.slice(0, track.relPath.lastIndexOf('/')) : '',
        'Books',
        true,
      );
      await this.#deps.downloadTrack({
        url,
        destAbsPath,
        headers,
        signal,
        onProgress: (p) => {
          const trackSize = track.size && track.size > 0 ? track.size : (p.total ?? 0);
          if (totalKnown > 0 && track.size) {
            useAbsMediaStore
              .getState()
              .updateProgress(job.id, completedBytes + p.progress * track.size, totalKnown);
          } else if (trackSize > 0) {
            useAbsMediaStore
              .getState()
              .updateProgress(job.id, completedBytes + p.progress * trackSize, totalKnown);
          }
        },
      });
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (!(await this.#deps.exists(partRel, 'Books'))) {
        throw new Error('Download did not produce a file');
      }
      try {
        await this.#deps.copyFile(partRel, 'Books', track.relPath, 'Books');
      } catch (err) {
        await this.#deps.deleteFile(partRel, 'Books').catch(() => undefined);
        throw err;
      }
      await this.#deps.deleteFile(partRel, 'Books');
      const st = await this.#deps.stats(track.relPath, 'Books');
      if (track.size != null && track.size > 0 && st.size !== track.size) {
        throw new Error('Downloaded file size mismatch');
      }
      track.complete = true;
      snapshot.updatedAt = Date.now();
      await this.#deps.writeSnapshot(appService, snapshot);
    } catch (err) {
      await this.#deps.deleteFile(partRel, 'Books').catch(() => undefined);
      throw err;
    }
  }

  async #seedProgress(
    client: AbsDownloadClient,
    bookHash: string,
    itemId: string,
    episodeId?: string,
  ): Promise<void> {
    try {
      const me = await client.getMe();
      const progress = me.mediaProgress.find(
        (entry) =>
          entry.libraryItemId === itemId &&
          (entry.episodeId || undefined) === (episodeId || undefined),
      );
      if (!progress) return;
      const localPlayed = readLocalLastPlayedAt(bookHash, episodeId);
      if (!isLocalProgressFresher(localPlayed, progress.lastUpdate)) {
        writeLocalPos(bookHash, progress.currentTime, episodeId);
      }
      const existing = findOutboxRow(itemId, episodeId);
      const localWins = isLocalProgressFresher(localPlayed, progress.lastUpdate);
      upsertOutbox({
        bookHash,
        itemId,
        ...(episodeId ? { episodeId } : {}),
        localSessionId: existing?.localSessionId ?? '',
        currentTime: existing?.dirty
          ? existing.currentTime
          : localWins
            ? (existing?.currentTime ?? progress.currentTime)
            : progress.currentTime,
        duration: progress.duration,
        timeListening: existing?.timeListening ?? 0,
        lastPlayedAt: existing?.lastPlayedAt ?? 0,
        dirty: existing?.dirty ?? false,
        serverLastUpdateCached: progress.lastUpdate,
      });
    } catch (err) {
      console.warn(err);
    }
  }

  #ensureLoaded(): void {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      if (typeof localStorage === 'undefined') return;
      const stored = localStorage.getItem(QUEUE_KEY);
      if (stored) {
        const data = JSON.parse(stored) as PersistedQueueData;
        useAbsMediaStore.getState().restoreItems(data.items ?? {});
      }
      const index = localStorage.getItem(INDEX_KEY);
      if (index) {
        useAbsMediaStore
          .getState()
          .restorePresence(JSON.parse(index) as Record<string, AbsMediaPresence>);
      }
    } catch (err) {
      console.error('Failed to load ABS media queue', err);
    }
  }

  #persistQueue(): void {
    try {
      if (typeof localStorage === 'undefined') return;
      const data: PersistedQueueData = {
        schemaVersion: QUEUE_SCHEMA_VERSION,
        items: useAbsMediaStore.getState().items,
      };
      localStorage.setItem(QUEUE_KEY, JSON.stringify(data));
    } catch (err) {
      console.error('Failed to persist ABS media queue', err);
    }
  }

  #persistIndex(): void {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(INDEX_KEY, JSON.stringify(useAbsMediaStore.getState().presence));
    } catch (err) {
      console.error('Failed to persist ABS media index', err);
    }
  }
}

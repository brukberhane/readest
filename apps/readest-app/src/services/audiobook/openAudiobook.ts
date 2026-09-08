// Wires a library book backed by an Audiobookshelf server into a live
// AudiobookController session: resolves the server, fetches the expanded
// item (tracks + chapters), opens the server-side listening session (which
// resolves the resume position), and claims the controller on the shared
// TTSSessionManager slot so the same background-session machinery TTS uses
// (lock screen, sleep timer, NowPlayingBar) drives audiobook playback too.
//
// Idempotent: reopening the same book hash while its session is still alive
// reuses it instead of claiming a second one.

import { convertFileSrc } from '@tauri-apps/api/core';
import { AudiobookController, type AudiobookSource } from './AudiobookController';
import { HtmlAudioClock } from './AudiobookClock';
import { NativeAudiobookClock } from './NativeAudiobookClock';
import { ABSAuthError } from '@/services/audiobookshelf/client';
import { createAbsClient } from '@/services/audiobookshelf/createClient';
import {
  mergeAbsSnapshot,
  readShowCache,
  readSnapshot,
  snapshotFromExpanded,
  writeShowCache,
  writeSnapshot,
  type AbsPlaybackSnapshot,
  type AbsSnapshotTrack,
} from '@/services/audiobookshelf/playbackSnapshot';
import { readOutbox } from '@/services/audiobookshelf/progressOutbox';
import {
  AbsProgressSyncer,
  readLocalLastPlayedAt,
  readLocalPos,
} from '@/services/audiobookshelf/progressSync';
import { findABSServerById, useABSServerStore } from '@/store/absServerStore';
import { ttsSessionManager } from '@/services/tts/TTSSessionManager';
import type { TTSMediaBridgeMeta } from '@/services/tts/ttsMediaBridge';
import { buildAbsMediaUrl, parseAbsFilePath } from '@/utils/audiobook';
import { getOSPlatform, stubTranslation as _, uniqueId } from '@/utils/misc';
import { isTauriAppPlatform } from '@/services/environment';
import { eventDispatcher } from '@/utils/event';
import type { AppService } from '@/types/system';
import type { Book } from '@/types/book';
import type {
  ABSChapter,
  ABSEpisode,
  ABSLibraryItem,
  ABSMediaProgress,
  ABSServer,
  ABSTrack,
} from '@/types/audiobookshelf';

// iOS Tauri must use the app-process AVPlayer (mirrors MediaOverlayClient's
// NativeNarrationPlayer split): WebKit HTMLMediaElement / WebAudio cannot own
// the app's non-mixable audio session.
const isIOSTauri = (): boolean => isTauriAppPlatform() && getOSPlatform() === 'ios';

const notifyConnectionError = (serverName: string): void => {
  eventDispatcher.dispatch('toast', {
    message: _('Unable to connect to {{server}}').replace('{{server}}', serverName),
    type: 'error',
  });
};

const notifyServerNotFound = (): void => {
  eventDispatcher.dispatch('toast', {
    message: _('Audiobookshelf server not found'),
    type: 'error',
  });
};

const notifyEpisodeNotFound = (): void => {
  eventDispatcher.dispatch('toast', {
    message: _('Episode not found'),
    type: 'error',
  });
};

/** Resolves the server config for a library book, toasting when it's gone. */
const resolveServer = (book: Book): { itemId: string; server: ABSServer } | null => {
  const parsed = parseAbsFilePath(book.filePath);
  const server = parsed ? findABSServerById(parsed.serverId) : undefined;
  if (!parsed || !server) {
    notifyServerNotFound();
    return null;
  }
  return { itemId: parsed.itemId, server };
};

const tracksFromSnapshot = (snapshot: AbsPlaybackSnapshot): ABSTrack[] =>
  snapshot.tracks.map((track) => ({
    index: track.index,
    startOffset: track.startOffset,
    duration: track.duration,
    contentUrl: track.contentUrl,
    mimeType: track.mimeType,
    ino: track.fileId,
    ...(track.size != null ? { size: track.size } : {}),
  }));

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
      author: item.media.metadata.title || book.title,
      episodeId: episode.id,
    },
  );
};

const refreshTrackCompleteness = async (
  appService: AppService,
  snapshot: AbsPlaybackSnapshot,
): Promise<AbsPlaybackSnapshot> => {
  const tracks: AbsSnapshotTrack[] = [];
  for (const track of snapshot.tracks) {
    let complete = false;
    try {
      if (await appService.exists(track.relPath, 'Books')) {
        if (track.size != null && track.size > 0) {
          const st = await appService.stats(track.relPath, 'Books');
          complete = st.size === track.size;
        } else {
          complete = true;
        }
      }
    } catch {
      complete = false;
    }
    tracks.push({ ...track, complete });
  }
  return { ...snapshot, tracks, updatedAt: Date.now() };
};

const buildUrlByContent = async (
  appService: AppService,
  snapshot: AbsPlaybackSnapshot | null,
): Promise<Map<string, string>> => {
  const map = new Map<string, string>();
  if (!snapshot || !isTauriAppPlatform()) return map;
  for (const track of snapshot.tracks) {
    if (!track.complete) continue;
    try {
      if (!(await appService.exists(track.relPath, 'Books'))) continue;
      if (track.size != null && track.size > 0) {
        const st = await appService.stats(track.relPath, 'Books');
        if (st.size !== track.size) continue;
      }
      const absPath = await appService.resolveFilePath(track.relPath, 'Books');
      map.set(track.contentUrl, isIOSTauri() ? absPath : convertFileSrc(absPath));
    } catch {
      // Missing or unreadable files fall through to HTTP.
    }
  }
  return map;
};

/**
 * Idempotent: reuses the live session for the same (book hash, episodeId),
 * else claims a new one.
 *
 * A podcast book (`book.absMediaType === 'podcast'`) has no book-level
 * session: `episodeId` is required to open one. Without it, this returns
 * null without claiming or opening any server session, and without a toast
 * - the player route renders the episode list instead, so this isn't an
 * error (see loadAbsEpisodes).
 */
export const openAudiobookSession = async (input: {
  appService: AppService;
  book: Book;
  episodeId?: string;
}): Promise<{ bookKey: string; controller: AudiobookController } | null> => {
  const { appService, book } = input;
  const episodeId = input.episodeId || undefined;

  if (book.absMediaType === 'podcast' && !episodeId) {
    return null;
  }

  const existing = ttsSessionManager.getSessionByHash(book.hash);
  if (existing && existing.controller.kind === 'audiobook') {
    const controller = existing.controller as AudiobookController;
    // A show can have several live-switchable episodes: reuse only when the
    // live session is for the SAME episode. A different episode falls
    // through to claim a fresh session below - TTSSessionManager.claim
    // swaps it into the same slot, tearing the old one down via shutdown,
    // the same as switching to a different book.
    if (controller.getEpisodeId() === episodeId) {
      return { bookKey: existing.bookKey, controller };
    }
  }

  const resolved = resolveServer(book);
  if (!resolved) return null;
  const { itemId, server } = resolved;

  try {
    const client = createAbsClient(appService, server);
    const skipNetwork = typeof navigator !== 'undefined' && navigator.onLine === false;

    let tracks: ABSTrack[];
    let chapters: ABSChapter[];
    let title: string;
    let author: string;
    let duration: number;
    let snapshot: AbsPlaybackSnapshot | null = null;

    if (!skipNetwork) {
      try {
        const item = await client.getItemExpanded(itemId);
        if (episodeId) {
          const episode = item.media.episodes?.find((e) => e.id === episodeId);
          if (!episode?.audioTrack) {
            notifyEpisodeNotFound();
            return null;
          }
          tracks = [episode.audioTrack];
          chapters = episode.chapters ?? [];
          title = episode.title;
          author = item.media.metadata.title || book.title;
          duration = episode.duration ?? episode.audioTrack.duration;
          const existingSnap = await readSnapshot(appService, book.hash, episodeId);
          snapshot = await refreshTrackCompleteness(
            appService,
            mergeAbsSnapshot(snapshotForEpisode(item, book, episode), existingSnap),
          );
        } else {
          tracks = item.media.tracks ?? [];
          chapters = item.media.chapters ?? [];
          title = book.title;
          author = book.author;
          duration = item.media.duration ?? tracks.reduce((sum, track) => sum + track.duration, 0);
          const existingSnap = await readSnapshot(appService, book.hash);
          snapshot = await refreshTrackCompleteness(
            appService,
            mergeAbsSnapshot(
              snapshotFromExpanded(item, book.hash, { title: book.title, author: book.author }),
              existingSnap,
            ),
          );
        }
        await writeSnapshot(appService, snapshot);
        if (item.mediaType === 'podcast' && item.media.episodes) {
          await writeShowCache(appService, book.hash, {
            version: 1,
            itemId,
            savedAt: Date.now(),
            episodes: item.media.episodes,
          });
        }
      } catch (error) {
        if (error instanceof ABSAuthError) throw error;
        snapshot = await readSnapshot(appService, book.hash, episodeId);
        if (!snapshot) {
          notifyConnectionError(server.name);
          return null;
        }
        tracks = tracksFromSnapshot(snapshot);
        chapters = snapshot.chapters;
        title = snapshot.title;
        author = snapshot.author;
        duration = snapshot.duration;
      }
    } else {
      snapshot = await readSnapshot(appService, book.hash, episodeId);
      if (!snapshot) {
        notifyConnectionError(server.name);
        return null;
      }
      tracks = tracksFromSnapshot(snapshot);
      chapters = snapshot.chapters;
      title = snapshot.title;
      author = snapshot.author;
      duration = snapshot.duration;
    }

    const urlByContent = await buildUrlByContent(appService, snapshot);

    const syncer = new AbsProgressSyncer({
      client,
      itemId,
      episodeId,
      bookHash: book.hash,
      duration,
      appService,
    });
    const startAt = episodeId
      ? skipNetwork
        ? await syncer.begin(
            readLocalPos(book.hash, episodeId),
            readLocalLastPlayedAt(book.hash, episodeId),
            { offline: true },
          )
        : await syncer.begin(
            readLocalPos(book.hash, episodeId),
            readLocalLastPlayedAt(book.hash, episodeId),
          )
      : skipNetwork
        ? await syncer.begin(book.progress?.[0] ?? 0, readLocalLastPlayedAt(book.hash), {
            offline: true,
          })
        : await syncer.begin(book.progress?.[0] ?? 0, readLocalLastPlayedAt(book.hash));

    const sourceObj: AudiobookSource = {
      itemId,
      episodeId,
      title,
      author,
      tracks,
      chapters,
      // Reads the server's CURRENT accessToken on every call - never a
      // captured copy - so a track load issued after a 401-triggered token
      // refresh (by this client or another, e.g. the periodic library sync)
      // carries the rotated token instead of the one this session started
      // with. Local complete files are resolved from the precomputed map.
      resolveUrl: (contentPath: string) =>
        urlByContent.get(contentPath) ??
        buildAbsMediaUrl(useABSServerStore.getState().getServer(server.id) ?? server, contentPath),
      startAt,
    };

    const nativeClock = isIOSTauri();
    const clock = nativeClock ? new NativeAudiobookClock() : new HtmlAudioClock();
    const controller = new AudiobookController(sourceObj, clock, syncer.hooks());

    const bookKey = `${book.hash}-${uniqueId()}`;
    const meta: TTSMediaBridgeMeta = {
      bookKey,
      title,
      author,
      coverImageUrl: book.coverImageUrl ?? null,
      metadataMode: 'chapter',
      // HtmlAudioClock plays through a WebView media element, and Chromium
      // requests Android audio focus for it in this same app. The media
      // service must not request focus too: Chromium's request preempts it,
      // and the service relays that AUDIOFOCUS_LOSS as a media-session-pause
      // that stopped playback right after it started.
      ownsAudioFocus: nativeClock,
      getSectionLabel: () => controller.getCurrentChapter()?.title,
    };
    ttsSessionManager.claim(bookKey, controller, meta);

    return { bookKey, controller };
  } catch (error) {
    console.warn('[ABS] failed to open audiobook session:', error);
    notifyConnectionError(server.name);
    return null;
  }
};

/**
 * Loads a podcast show's episodes and each episode's server-side progress,
 * for the player route's episode list. Episodes come back newest-first by
 * publishedAt. Never claims a session - pass the chosen episode's id to
 * openAudiobookSession to actually play it.
 */
export const loadAbsEpisodes = async (
  appService: AppService,
  book: Book,
): Promise<{
  episodes: ABSEpisode[];
  progressByEpisodeId: Map<string, ABSMediaProgress>;
} | null> => {
  const resolved = resolveServer(book);
  if (!resolved) return null;
  const { itemId, server } = resolved;

  try {
    const client = createAbsClient(appService, server);
    const [item, me] = await Promise.all([client.getItemExpanded(itemId), client.getMe()]);

    const episodes = [...(item.media.episodes ?? [])].sort(
      (a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0),
    );
    const progressByEpisodeId = new Map<string, ABSMediaProgress>();
    for (const progress of me.mediaProgress) {
      if (progress.libraryItemId === itemId && progress.episodeId) {
        progressByEpisodeId.set(progress.episodeId, progress);
      }
    }

    await writeShowCache(appService, book.hash, {
      version: 1,
      itemId,
      savedAt: Date.now(),
      episodes: item.media.episodes ?? [],
    });

    return { episodes, progressByEpisodeId };
  } catch (error) {
    if (error instanceof ABSAuthError) {
      console.warn('[ABS] failed to load episodes:', error);
      notifyConnectionError(server.name);
      return null;
    }
    try {
      const cache = await readShowCache(appService, book.hash);
      if (!cache) {
        console.warn('[ABS] failed to load episodes:', error);
        notifyConnectionError(server.name);
        return null;
      }
      const episodes = [...cache.episodes].sort(
        (a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0),
      );
      const progressByEpisodeId = new Map<string, ABSMediaProgress>();
      for (const row of readOutbox()) {
        if (row.itemId !== itemId || !row.episodeId) continue;
        progressByEpisodeId.set(row.episodeId, {
          libraryItemId: itemId,
          episodeId: row.episodeId,
          currentTime: row.currentTime,
          duration: row.duration,
          isFinished: row.duration > 0 && row.currentTime / row.duration >= 0.99,
          lastUpdate: row.lastPlayedAt,
        });
      }
      return { episodes, progressByEpisodeId };
    } catch (cacheError) {
      console.warn('[ABS] failed to load episodes:', cacheError);
      notifyConnectionError(server.name);
      return null;
    }
  }
};

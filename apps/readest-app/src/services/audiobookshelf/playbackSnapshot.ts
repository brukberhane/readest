import type { ABSChapter, ABSEpisode, ABSLibraryItem, ABSTrack } from '@/types/audiobookshelf';
import type { AppService } from '@/types/system';
import { normalizeAbsTrack } from '@/services/audiobookshelf/normalizeTrack';

export const ABS_SNAPSHOT_VERSION = 1 as const;

export interface AbsSnapshotTrack {
  index: number;
  startOffset: number;
  duration: number;
  contentUrl: string;
  mimeType: string;
  fileId: string;
  relPath: string;
  size?: number;
  complete: boolean;
}

export interface AbsPlaybackSnapshot {
  version: typeof ABS_SNAPSHOT_VERSION;
  bookHash: string;
  itemId: string;
  episodeId?: string;
  title: string;
  author: string;
  duration: number;
  chapters: ABSChapter[];
  tracks: AbsSnapshotTrack[];
  updatedAt: number;
}

export interface AbsShowCache {
  version: 1;
  itemId: string;
  savedAt: number;
  episodes: ABSEpisode[];
}

export const snapshotIsComplete = (snapshot: AbsPlaybackSnapshot): boolean =>
  snapshot.tracks.length > 0 && snapshot.tracks.every((track) => track.complete);

export const mergeAbsSnapshot = (
  fresh: AbsPlaybackSnapshot,
  existing: AbsPlaybackSnapshot | null,
): AbsPlaybackSnapshot => {
  if (!existing) return fresh;
  const byId = new Map(existing.tracks.map((track) => [track.fileId, track]));
  return {
    ...fresh,
    tracks: fresh.tracks.map((track) => {
      const prev = byId.get(track.fileId);
      if (!prev?.complete) return track;
      if (track.size != null && prev.size != null && track.size !== prev.size) return track;
      return { ...track, complete: true, relPath: prev.relPath };
    }),
  };
};

const assertSafeEpisodeId = (episodeId?: string): void => {
  if (!episodeId) return;
  if (episodeId.includes('..') || episodeId.includes('/') || episodeId.includes('\\')) {
    throw new Error('Invalid episode id');
  }
};

export const absMediaDir = (bookHash: string, episodeId?: string): string => {
  assertSafeEpisodeId(episodeId);
  return episodeId ? `${bookHash}/abs-media/${episodeId}` : `${bookHash}/abs-media`;
};

export const absSnapshotPath = (bookHash: string, episodeId?: string): string =>
  `${absMediaDir(bookHash, episodeId)}/snapshot.json`;

export const absShowCachePath = (bookHash: string): string => `${bookHash}/abs-media/show.json`;

export const absTrackRelPath = (
  bookHash: string,
  fileId: string,
  ext: string,
  episodeId?: string,
): string => `${absMediaDir(bookHash, episodeId)}/track-${fileId}.${ext}`;

export const absTrackPartPath = (
  bookHash: string,
  fileId: string,
  ext: string,
  episodeId?: string,
): string => `${absTrackRelPath(bookHash, fileId, ext, episodeId)}.part`;

const sanitizeFileId = (value: string): string => value.replace(/[^A-Za-z0-9._-]/g, '_') || 'track';

export const fileIdFromTrack = (
  track: Pick<ABSTrack, 'index' | 'contentUrl'> & { ino?: string },
): string => {
  if (track.ino) return sanitizeFileId(track.ino);
  const fileMatch = track.contentUrl.match(/\/file\/([^/?]+)/);
  if (fileMatch?.[1]) return sanitizeFileId(fileMatch[1]);
  return sanitizeFileId(String(track.index));
};

export const extFromMime = (mime: string): string => {
  const normalized = mime.toLowerCase();
  if (normalized === 'audio/mpeg') return 'mp3';
  if (normalized === 'audio/mp4' || normalized === 'audio/aac' || normalized === 'audio/m4a') {
    return 'm4a';
  }
  if (normalized === 'audio/ogg') return 'ogg';
  if (normalized === 'audio/flac') return 'flac';
  if (normalized === 'audio/webm') return 'webm';
  return 'bin';
};

const readJsonOrNull = async <T>(
  appService: Pick<AppService, 'readFile'>,
  path: string,
): Promise<T | null> => {
  try {
    const raw = await appService.readFile(path, 'Books', 'text');
    if (typeof raw !== 'string') return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

export const writeSnapshot = async (
  appService: Pick<AppService, 'createDir' | 'writeFile'>,
  snapshot: AbsPlaybackSnapshot,
): Promise<void> => {
  assertSafeEpisodeId(snapshot.episodeId);
  await appService.createDir(absMediaDir(snapshot.bookHash, snapshot.episodeId), 'Books', true);
  await appService.writeFile(
    absSnapshotPath(snapshot.bookHash, snapshot.episodeId),
    'Books',
    JSON.stringify(snapshot),
  );
};

export const readSnapshot = async (
  appService: Pick<AppService, 'readFile'>,
  bookHash: string,
  episodeId?: string,
): Promise<AbsPlaybackSnapshot | null> => {
  assertSafeEpisodeId(episodeId);
  return readJsonOrNull<AbsPlaybackSnapshot>(appService, absSnapshotPath(bookHash, episodeId));
};

export const writeShowCache = async (
  appService: Pick<AppService, 'createDir' | 'writeFile'>,
  bookHash: string,
  cache: AbsShowCache,
): Promise<void> => {
  await appService.createDir(absMediaDir(bookHash), 'Books', true);
  await appService.writeFile(absShowCachePath(bookHash), 'Books', JSON.stringify(cache));
};

export const readShowCache = async (
  appService: Pick<AppService, 'readFile'>,
  bookHash: string,
): Promise<AbsShowCache | null> =>
  readJsonOrNull<AbsShowCache>(appService, absShowCachePath(bookHash));

export const deleteAbsMedia = async (
  appService: Pick<AppService, 'deleteDir'>,
  bookHash: string,
  episodeId?: string,
): Promise<void> => {
  assertSafeEpisodeId(episodeId);
  await appService.deleteDir(absMediaDir(bookHash, episodeId), 'Books', true);
};

export const snapshotFromExpanded = (
  item: ABSLibraryItem,
  bookHash: string,
  meta: { title: string; author: string; episodeId?: string },
): AbsPlaybackSnapshot => {
  assertSafeEpisodeId(meta.episodeId);
  const tracks = item.media.tracks ?? [];
  return {
    version: ABS_SNAPSHOT_VERSION,
    bookHash,
    itemId: item.id,
    ...(meta.episodeId ? { episodeId: meta.episodeId } : {}),
    title: meta.title,
    author: meta.author,
    duration: item.media.duration ?? tracks.reduce((sum, track) => sum + track.duration, 0),
    chapters: item.media.chapters ?? [],
    tracks: tracks.map((track) => {
      const normalized = normalizeAbsTrack(track);
      const fileId = fileIdFromTrack(normalized);
      const ext = extFromMime(normalized.mimeType);
      return {
        index: normalized.index,
        startOffset: normalized.startOffset,
        duration: normalized.duration,
        contentUrl: normalized.contentUrl,
        mimeType: normalized.mimeType,
        fileId,
        relPath: absTrackRelPath(bookHash, fileId, ext, meta.episodeId),
        ...(normalized.size != null ? { size: normalized.size } : {}),
        complete: false,
      };
    }),
    updatedAt: Date.now(),
  };
};

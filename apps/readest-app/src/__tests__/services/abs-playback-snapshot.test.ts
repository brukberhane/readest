import { describe, expect, it } from 'vitest';

import type { ABSLibraryItem } from '@/types/audiobookshelf';
import type { AppService } from '@/types/system';
import {
  absMediaDir,
  absShowCachePath,
  absSnapshotPath,
  absTrackPartPath,
  absTrackRelPath,
  deleteAbsMedia,
  extFromMime,
  fileIdFromTrack,
  mergeAbsSnapshot,
  readShowCache,
  readSnapshot,
  snapshotFromExpanded,
  snapshotIsComplete,
  writeShowCache,
  writeSnapshot,
  type AbsPlaybackSnapshot,
} from '@/services/audiobookshelf/playbackSnapshot';

const makeAppService = () => {
  const files = new Map<string, string | ArrayBuffer>();
  const dirs = new Set<string>();

  const appService = {
    createDir: async (path: string) => {
      dirs.add(path.replace(/\/+$/, ''));
    },
    writeFile: async (path: string, _base: string, content: string | ArrayBuffer) => {
      files.set(path, typeof content === 'string' ? content : content);
    },
    readFile: async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing: ${path}`);
      return value;
    },
    exists: async (path: string) => files.has(path) || dirs.has(path),
    deleteFile: async (path: string) => {
      files.delete(path);
    },
    deleteDir: async (path: string, _base: string, recursive?: boolean) => {
      const prefix = path.replace(/\/+$/, '');
      if (recursive) {
        for (const key of [...files.keys()]) {
          if (key === prefix || key.startsWith(`${prefix}/`)) files.delete(key);
        }
        for (const dir of [...dirs]) {
          if (dir === prefix || dir.startsWith(`${prefix}/`)) dirs.delete(dir);
        }
      } else {
        dirs.delete(prefix);
      }
    },
    stats: async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing: ${path}`);
      const size = typeof value === 'string' ? value.length : value.byteLength;
      return { isFile: true, isDirectory: false, size, mtime: null, atime: null, birthtime: null };
    },
  } as unknown as AppService;

  return { appService, files };
};

const sampleSnapshot = (overrides: Partial<AbsPlaybackSnapshot> = {}): AbsPlaybackSnapshot => ({
  version: 1,
  bookHash: 'h1',
  itemId: 'item1',
  title: 'Pride',
  author: 'Jane',
  duration: 100,
  chapters: [{ id: 0, start: 0, end: 100, title: 'One' }],
  tracks: [
    {
      index: 1,
      startOffset: 0,
      duration: 100,
      contentUrl: '/api/items/item1/file/abc',
      mimeType: 'audio/mpeg',
      fileId: 'abc',
      relPath: 'h1/abs-media/track-abc.mp3',
      complete: false,
    },
  ],
  updatedAt: 1,
  ...overrides,
});

describe('abs-media path helpers', () => {
  it('absMediaDir("h1") is h1/abs-media; with episode h1/abs-media/ep1', () => {
    expect(absMediaDir('h1')).toBe('h1/abs-media');
    expect(absMediaDir('h1', 'ep1')).toBe('h1/abs-media/ep1');
  });

  it('episode dir is not the book dir (no file clash)', () => {
    expect(absSnapshotPath('h1')).toBe('h1/abs-media/snapshot.json');
    expect(absSnapshotPath('h1', 'ep1')).toBe('h1/abs-media/ep1/snapshot.json');
    expect(absSnapshotPath('h1')).not.toBe(absSnapshotPath('h1', 'ep1'));
    expect(absShowCachePath('h1')).toBe('h1/abs-media/show.json');
    expect(absTrackRelPath('h1', 'abc', 'mp3')).toBe('h1/abs-media/track-abc.mp3');
    expect(absTrackRelPath('h1', 'abc', 'mp3', 'ep1')).toBe('h1/abs-media/ep1/track-abc.mp3');
    expect(absTrackPartPath('h1', 'abc', 'mp3')).toBe('h1/abs-media/track-abc.mp3.part');
  });

  it('fileIdFromTrack prefers ino, else last /file/ segment, else index', () => {
    expect(fileIdFromTrack({ index: 3, contentUrl: '/api/items/x/file/zzz', ino: 'ino-1' })).toBe(
      'ino-1',
    );
    expect(fileIdFromTrack({ index: 3, contentUrl: '/api/items/x/file/zzz' })).toBe('zzz');
    expect(fileIdFromTrack({ index: 3, contentUrl: '/hls/foo' })).toBe('3');
  });

  it('extFromMime maps known types', () => {
    expect(extFromMime('audio/mpeg')).toBe('mp3');
    expect(extFromMime('audio/mp4')).toBe('m4a');
    expect(extFromMime('audio/aac')).toBe('m4a');
    expect(extFromMime('audio/m4a')).toBe('m4a');
    expect(extFromMime('audio/ogg')).toBe('ogg');
    expect(extFromMime('audio/flac')).toBe('flac');
    expect(extFromMime('audio/webm')).toBe('webm');
    expect(extFromMime('application/octet-stream')).toBe('bin');
  });
});

describe('snapshot completeness', () => {
  it('is false when any complete is false or tracks are empty', () => {
    expect(snapshotIsComplete(sampleSnapshot())).toBe(false);
    expect(snapshotIsComplete(sampleSnapshot({ tracks: [] }))).toBe(false);
    expect(
      snapshotIsComplete(
        sampleSnapshot({
          tracks: [{ ...sampleSnapshot().tracks[0]!, complete: true }],
        }),
      ),
    ).toBe(true);
  });
});

describe('snapshot disk', () => {
  it('writeSnapshot + readSnapshot round-trip; missing file returns null', async () => {
    const { appService } = makeAppService();
    const snapshot = sampleSnapshot();
    await writeSnapshot(appService, snapshot);
    expect(await readSnapshot(appService, 'h1')).toEqual(snapshot);
    expect(await readSnapshot(appService, 'missing')).toBeNull();
  });

  it('deleteAbsMedia(bookHash) deletes the abs-media dir; episode delete leaves a sibling', async () => {
    const { appService, files } = makeAppService();
    await writeSnapshot(appService, sampleSnapshot({ episodeId: 'ep1' }));
    await writeSnapshot(appService, sampleSnapshot({ episodeId: 'ep2', itemId: 'item2' }));
    await writeSnapshot(appService, sampleSnapshot());

    await deleteAbsMedia(appService, 'h1', 'ep1');
    expect(await readSnapshot(appService, 'h1', 'ep1')).toBeNull();
    expect(await readSnapshot(appService, 'h1', 'ep2')).not.toBeNull();
    expect(await readSnapshot(appService, 'h1')).not.toBeNull();

    await deleteAbsMedia(appService, 'h1');
    expect(await readSnapshot(appService, 'h1')).toBeNull();
    expect(await readSnapshot(appService, 'h1', 'ep2')).toBeNull();
    expect([...files.keys()].some((key) => key.startsWith('h1/abs-media'))).toBe(false);
  });

  it('snapshotFromExpanded copies tracks/chapters with complete false', () => {
    const item: ABSLibraryItem = {
      id: 'item1',
      mediaType: 'book',
      media: {
        metadata: { title: 'Pride', authorName: 'Jane' },
        duration: 100,
        tracks: [
          {
            index: 1,
            startOffset: 0,
            duration: 100,
            contentUrl: '/api/items/item1/file/abc',
            mimeType: 'audio/mpeg',
            ino: 'abc',
            size: 12,
          },
        ],
        chapters: [{ id: 0, start: 0, end: 100, title: 'One' }],
      },
    };
    const snapshot = snapshotFromExpanded(item, 'h1', {
      title: 'Pride',
      author: 'Jane',
    });
    expect(snapshot.itemId).toBe('item1');
    expect(snapshot.bookHash).toBe('h1');
    expect(snapshot.tracks).toHaveLength(1);
    expect(snapshot.tracks[0]).toMatchObject({
      fileId: 'abc',
      complete: false,
      relPath: 'h1/abs-media/track-abc.mp3',
      size: 12,
    });
    expect(snapshot.chapters).toHaveLength(1);
    expect(snapshotIsComplete(snapshot)).toBe(false);
  });

  it('rejects path traversal in episodeId before any write', async () => {
    const { appService, files } = makeAppService();
    await expect(
      writeSnapshot(appService, sampleSnapshot({ episodeId: '../evil' })),
    ).rejects.toThrow();
    await expect(writeSnapshot(appService, sampleSnapshot({ episodeId: 'a/b' }))).rejects.toThrow();
    expect(files.size).toBe(0);
  });

  it('mergeAbsSnapshot keeps complete when fileId and size match', () => {
    const existing = sampleSnapshot({
      tracks: [
        {
          index: 1,
          startOffset: 0,
          duration: 100,
          contentUrl: '/api/items/item1/file/abc',
          mimeType: 'audio/mpeg',
          fileId: 'abc',
          relPath: 'h1/abs-media/track-abc.mp3',
          size: 12,
          complete: true,
        },
      ],
    });
    const fresh = sampleSnapshot({
      tracks: [
        {
          index: 1,
          startOffset: 0,
          duration: 100,
          contentUrl: '/api/items/item1/file/abc',
          mimeType: 'audio/mpeg',
          fileId: 'abc',
          relPath: 'h1/abs-media/track-abc.mp3',
          size: 12,
          complete: false,
        },
      ],
    });
    const merged = mergeAbsSnapshot(fresh, existing);
    expect(merged.tracks[0]).toMatchObject({
      complete: true,
      relPath: existing.tracks[0]!.relPath,
    });
  });

  it('mergeAbsSnapshot marks complete false when size changes and does not delete', () => {
    const existing = sampleSnapshot({
      tracks: [
        {
          index: 1,
          startOffset: 0,
          duration: 100,
          contentUrl: '/api/items/item1/file/abc',
          mimeType: 'audio/mpeg',
          fileId: 'abc',
          relPath: 'h1/abs-media/track-abc.mp3',
          size: 12,
          complete: true,
        },
      ],
    });
    const fresh = sampleSnapshot({
      tracks: [
        {
          index: 1,
          startOffset: 0,
          duration: 100,
          contentUrl: '/api/items/item1/file/abc',
          mimeType: 'audio/mpeg',
          fileId: 'abc',
          relPath: 'h1/abs-media/track-abc.mp3',
          size: 99,
          complete: false,
        },
      ],
    });
    const merged = mergeAbsSnapshot(fresh, existing);
    expect(merged.tracks[0]!.complete).toBe(false);
    expect(merged.tracks[0]!.size).toBe(99);
  });

  it('mergeAbsSnapshot marks complete false when fileId changes', () => {
    const existing = sampleSnapshot({
      tracks: [
        {
          index: 1,
          startOffset: 0,
          duration: 100,
          contentUrl: '/api/items/item1/file/abc',
          mimeType: 'audio/mpeg',
          fileId: 'abc',
          relPath: 'h1/abs-media/track-abc.mp3',
          size: 12,
          complete: true,
        },
      ],
    });
    const fresh = sampleSnapshot({
      tracks: [
        {
          index: 1,
          startOffset: 0,
          duration: 100,
          contentUrl: '/api/items/item1/file/zzz',
          mimeType: 'audio/mpeg',
          fileId: 'zzz',
          relPath: 'h1/abs-media/track-zzz.mp3',
          size: 12,
          complete: false,
        },
      ],
    });
    const merged = mergeAbsSnapshot(fresh, existing);
    expect(merged.tracks[0]).toMatchObject({ fileId: 'zzz', complete: false });
  });

  it('show cache round-trips', async () => {
    const { appService } = makeAppService();
    const cache = {
      version: 1 as const,
      itemId: 'show1',
      savedAt: 9,
      episodes: [{ id: 'ep1', title: 'E1' }],
    };
    await writeShowCache(appService, 'h1', cache);
    expect(await readShowCache(appService, 'h1')).toEqual(cache);
    expect(await readShowCache(appService, 'missing')).toBeNull();
  });
});

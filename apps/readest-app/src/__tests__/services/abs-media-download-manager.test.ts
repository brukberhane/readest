import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppService } from '@/types/system';
import type { Book } from '@/types/book';
import type { ABSEpisode, ABSLibraryItem, ABSServer } from '@/types/audiobookshelf';
import { makeAbsFilePath } from '@/utils/audiobook';
import { useAbsMediaStore } from '@/store/absMediaStore';
import { AbsMediaDownloadManager } from '@/services/audiobookshelf/mediaDownloadManager';
import {
  absTrackPartPath,
  absTrackRelPath,
  readSnapshot,
  writeSnapshot,
  type AbsPlaybackSnapshot,
} from '@/services/audiobookshelf/playbackSnapshot';
import { eventDispatcher } from '@/utils/event';

const makeFs = () => {
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
    copyFile: async (src: string, _sb: string, dst: string) => {
      const value = files.get(src);
      if (value === undefined) throw new Error(`missing: ${src}`);
      files.set(dst, value);
    },
  } as unknown as AppService;
  return { appService, files };
};

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

const twoTrackItem: ABSLibraryItem = {
  id: 'item1',
  mediaType: 'book',
  media: {
    metadata: { title: 'Pride', authorName: 'Jane' },
    duration: 20,
    tracks: [
      {
        index: 1,
        startOffset: 0,
        duration: 10,
        contentUrl: '/api/items/item1/file/a',
        mimeType: 'audio/mpeg',
        ino: 'a',
        size: 10,
      },
      {
        index: 2,
        startOffset: 10,
        duration: 10,
        contentUrl: '/api/items/item1/file/b',
        mimeType: 'audio/mpeg',
        ino: 'b',
        size: 20,
      },
    ],
    chapters: [],
  },
};

const episode: ABSEpisode = {
  id: 'ep1',
  title: 'Episode One',
  duration: 10,
  audioTrack: {
    index: 1,
    startOffset: 0,
    duration: 10,
    contentUrl: '/api/items/item1/file/epfile',
    mimeType: 'audio/mpeg',
    ino: 'epfile',
    size: 8,
  },
};

const podcastItem: ABSLibraryItem = {
  id: 'item1',
  mediaType: 'podcast',
  media: {
    metadata: { title: 'The Show', author: 'Net' },
    episodes: [episode],
  },
};

describe('AbsMediaDownloadManager', () => {
  beforeEach(() => {
    useAbsMediaStore.setState({ items: {}, presence: {} });
    localStorage.clear();
  });

  afterEach(() => {
    useAbsMediaStore.setState({ items: {}, presence: {} });
    localStorage.clear();
  });

  it('downloads two tracks to .part then complete files, with Bearer header', async () => {
    const { appService, files } = makeFs();
    const downloadTrack = vi.fn(
      async (input: {
        url: string;
        destAbsPath: string;
        headers: Record<string, string>;
        onProgress: (p: { progress: number; total?: number }) => void;
      }) => {
        const size = input.url.endsWith('/a') ? 10 : 20;
        files.set(input.destAbsPath, 'x'.repeat(size));
        input.onProgress({ progress: 1, total: size });
      },
    );
    const manager = new AbsMediaDownloadManager({
      downloadTrack,
      resolveAbsPath: async (rel) => rel,
      exists: appService.exists.bind(appService),
      stats: appService.stats.bind(appService),
      createDir: appService.createDir.bind(appService),
      deleteFile: appService.deleteFile.bind(appService),
      deleteDir: appService.deleteDir.bind(appService),
      copyFile: appService.copyFile.bind(appService),
      writeSnapshot,
      readSnapshot,
      isTauri: () => true,
      getClient: () => ({
        getItemExpanded: async () => twoTrackItem,
        getMe: async () => ({ mediaProgress: [] }),
        downloadUrlForTrack: (_id, track) => `http://abs.local${track.contentUrl}`,
      }),
      getServer: () => server,
    });

    await manager.queueBook({ appService, book });
    await vi.waitFor(() => expect(downloadTrack).toHaveBeenCalledTimes(2));
    expect(downloadTrack.mock.calls[0]![0].headers['Authorization']).toBe('Bearer token-1');
    expect(downloadTrack.mock.calls[0]![0].destAbsPath).toBe(absTrackPartPath('h1', 'a', 'mp3'));
    expect(downloadTrack.mock.calls[1]![0].destAbsPath).toBe(absTrackPartPath('h1', 'b', 'mp3'));
    await vi.waitFor(() =>
      expect(useAbsMediaStore.getState().presenceOf('h1')?.complete).toBe(true),
    );
    expect(files.has(absTrackRelPath('h1', 'a', 'mp3'))).toBe(true);
    expect(files.has(absTrackRelPath('h1', 'b', 'mp3'))).toBe(true);
    expect(files.has(absTrackPartPath('h1', 'a', 'mp3'))).toBe(false);
    const snap = await readSnapshot(appService, 'h1');
    expect(snap?.tracks.every((t) => t.complete)).toBe(true);
  });

  it('cancel abort: second track not called; .part deleted; not complete', async () => {
    const { appService, files } = makeFs();
    let resolveFirst: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const downloadTrack = vi.fn(
      async (input: {
        destAbsPath: string;
        headers: Record<string, string>;
        url: string;
        onProgress: (p: { progress: number; total?: number }) => void;
        signal?: AbortSignal;
      }) => {
        files.set(input.destAbsPath, 'part');
        if (downloadTrack.mock.calls.length === 1) {
          resolveFirst();
          await new Promise<void>((_resolve, reject) => {
            input.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          });
        }
      },
    );
    const manager = new AbsMediaDownloadManager({
      downloadTrack,
      resolveAbsPath: async (rel) => rel,
      exists: appService.exists.bind(appService),
      stats: appService.stats.bind(appService),
      createDir: appService.createDir.bind(appService),
      deleteFile: appService.deleteFile.bind(appService),
      deleteDir: appService.deleteDir.bind(appService),
      copyFile: appService.copyFile.bind(appService),
      writeSnapshot,
      readSnapshot,
      isTauri: () => true,
      getClient: () => ({
        getItemExpanded: async () => twoTrackItem,
        getMe: async () => ({ mediaProgress: [] }),
        downloadUrlForTrack: (_id, track) => `http://abs.local${track.contentUrl}`,
      }),
      getServer: () => server,
    });

    const queued = manager.queueBook({ appService, book });
    await firstStarted;
    manager.cancel('h1');
    await queued.catch(() => undefined);
    await vi.waitFor(() => expect(downloadTrack).toHaveBeenCalledTimes(1));
    expect(files.has(absTrackPartPath('h1', 'a', 'mp3'))).toBe(false);
    expect(useAbsMediaStore.getState().presenceOf('h1')?.complete).not.toBe(true);
  });

  it('downloader throw: job failed, .part gone, first complete track remains', async () => {
    const { appService, files } = makeFs();
    const downloadTrack = vi.fn(
      async (input: {
        url: string;
        destAbsPath: string;
        headers: Record<string, string>;
        onProgress: (p: { progress: number; total?: number }) => void;
      }) => {
        if (input.url.endsWith('/b')) throw new Error('network');
        files.set(input.destAbsPath, 'x'.repeat(10));
        input.onProgress({ progress: 1, total: 10 });
      },
    );
    const manager = new AbsMediaDownloadManager({
      downloadTrack,
      resolveAbsPath: async (rel) => rel,
      exists: appService.exists.bind(appService),
      stats: appService.stats.bind(appService),
      createDir: appService.createDir.bind(appService),
      deleteFile: appService.deleteFile.bind(appService),
      deleteDir: appService.deleteDir.bind(appService),
      copyFile: appService.copyFile.bind(appService),
      writeSnapshot,
      readSnapshot,
      isTauri: () => true,
      getClient: () => ({
        getItemExpanded: async () => twoTrackItem,
        getMe: async () => ({ mediaProgress: [] }),
        downloadUrlForTrack: (_id, track) => `http://abs.local${track.contentUrl}`,
      }),
      getServer: () => server,
    });

    await manager.queueBook({ appService, book });
    await vi.waitFor(() => expect(useAbsMediaStore.getState().itemOf('h1')?.status).toBe('failed'));
    expect(files.has(absTrackRelPath('h1', 'a', 'mp3'))).toBe(true);
    expect(files.has(absTrackPartPath('h1', 'b', 'mp3'))).toBe(false);
    const snap = await readSnapshot(appService, 'h1');
    expect(snap?.tracks[0]?.complete).toBe(true);
    expect(snap?.tracks[1]?.complete).toBe(false);
  });

  it('episode job uses the episode subdir', async () => {
    const { appService, files } = makeFs();
    const downloadTrack = vi.fn(
      async (input: {
        destAbsPath: string;
        headers: Record<string, string>;
        url: string;
        onProgress: (p: { progress: number; total?: number }) => void;
      }) => {
        files.set(input.destAbsPath, 'x'.repeat(8));
        input.onProgress({ progress: 1, total: 8 });
      },
    );
    const manager = new AbsMediaDownloadManager({
      downloadTrack,
      resolveAbsPath: async (rel) => rel,
      exists: appService.exists.bind(appService),
      stats: appService.stats.bind(appService),
      createDir: appService.createDir.bind(appService),
      deleteFile: appService.deleteFile.bind(appService),
      deleteDir: appService.deleteDir.bind(appService),
      copyFile: appService.copyFile.bind(appService),
      writeSnapshot,
      readSnapshot,
      isTauri: () => true,
      getClient: () => ({
        getItemExpanded: async () => podcastItem,
        getMe: async () => ({ mediaProgress: [] }),
        downloadUrlForTrack: (_id, track) => `http://abs.local${track.contentUrl}`,
      }),
      getServer: () => server,
    });

    await manager.queueEpisode({ appService, book, episode });
    await vi.waitFor(() =>
      expect(useAbsMediaStore.getState().presenceOf('h1', 'ep1')?.complete).toBe(true),
    );
    expect(files.has(absTrackRelPath('h1', 'epfile', 'mp3', 'ep1'))).toBe(true);
    expect(downloadTrack.mock.calls[0]![0].destAbsPath).toBe(
      absTrackPartPath('h1', 'epfile', 'mp3', 'ep1'),
    );
  });

  it('removeDownload deletes files, index false, library book not involved', async () => {
    const { appService, files } = makeFs();
    files.set(absTrackRelPath('h1', 'a', 'mp3'), 'x'.repeat(10));
    const snapshot: AbsPlaybackSnapshot = {
      version: 1,
      bookHash: 'h1',
      itemId: 'item1',
      title: 'Pride',
      author: 'Jane',
      duration: 10,
      chapters: [],
      tracks: [
        {
          index: 1,
          startOffset: 0,
          duration: 10,
          contentUrl: '/api/items/item1/file/a',
          mimeType: 'audio/mpeg',
          fileId: 'a',
          relPath: absTrackRelPath('h1', 'a', 'mp3'),
          size: 10,
          complete: true,
        },
      ],
      updatedAt: 1,
    };
    await writeSnapshot(appService, snapshot);
    useAbsMediaStore.getState().setPresence('h1', { bookHash: 'h1', complete: true, bytes: 10 });
    const manager = new AbsMediaDownloadManager({
      downloadTrack: async () => undefined,
      resolveAbsPath: async (rel) => rel,
      exists: appService.exists.bind(appService),
      stats: appService.stats.bind(appService),
      createDir: appService.createDir.bind(appService),
      deleteFile: appService.deleteFile.bind(appService),
      deleteDir: appService.deleteDir.bind(appService),
      copyFile: appService.copyFile.bind(appService),
      writeSnapshot,
      readSnapshot,
      isTauri: () => true,
      getClient: () => ({
        getItemExpanded: async () => twoTrackItem,
        getMe: async () => ({ mediaProgress: [] }),
        downloadUrlForTrack: (_id, track) => `http://abs.local${track.contentUrl}`,
      }),
      getServer: () => server,
    });

    await manager.removeDownload({ appService, bookHash: 'h1' });
    expect(files.has(absTrackRelPath('h1', 'a', 'mp3'))).toBe(false);
    expect(useAbsMediaStore.getState().presenceOf('h1')?.complete).toBe(false);
  });

  it('web guard: no download', async () => {
    const { appService } = makeFs();
    const downloadTrack = vi.fn();
    const toastSpy = vi.spyOn(eventDispatcher, 'dispatch');
    const manager = new AbsMediaDownloadManager({
      downloadTrack,
      resolveAbsPath: async (rel) => rel,
      exists: appService.exists.bind(appService),
      stats: appService.stats.bind(appService),
      createDir: appService.createDir.bind(appService),
      deleteFile: appService.deleteFile.bind(appService),
      deleteDir: appService.deleteDir.bind(appService),
      copyFile: appService.copyFile.bind(appService),
      writeSnapshot,
      readSnapshot,
      isTauri: () => false,
      getClient: () => ({
        getItemExpanded: async () => twoTrackItem,
        getMe: async () => ({ mediaProgress: [] }),
        downloadUrlForTrack: (_id, track) => `http://abs.local${track.contentUrl}`,
      }),
      getServer: () => server,
    });

    await manager.queueBook({ appService, book });
    expect(downloadTrack).not.toHaveBeenCalled();
    expect(useAbsMediaStore.getState().itemOf('h1')).toBeUndefined();
    expect(toastSpy).toHaveBeenCalledWith(
      'toast',
      expect.objectContaining({
        message: 'Offline playback is only available in the desktop and mobile apps',
      }),
    );
  });

  it('does not mark complete if stats.size disagrees with expected size', async () => {
    const { appService, files } = makeFs();
    const downloadTrack = vi.fn(
      async (input: {
        destAbsPath: string;
        headers: Record<string, string>;
        url: string;
        onProgress: (p: { progress: number; total?: number }) => void;
      }) => {
        files.set(input.destAbsPath, 'nope');
        input.onProgress({ progress: 1, total: 4 });
      },
    );
    const manager = new AbsMediaDownloadManager({
      downloadTrack,
      resolveAbsPath: async (rel) => rel,
      exists: appService.exists.bind(appService),
      stats: appService.stats.bind(appService),
      createDir: appService.createDir.bind(appService),
      deleteFile: appService.deleteFile.bind(appService),
      deleteDir: appService.deleteDir.bind(appService),
      copyFile: appService.copyFile.bind(appService),
      writeSnapshot,
      readSnapshot,
      isTauri: () => true,
      getClient: () => ({
        getItemExpanded: async () => twoTrackItem,
        getMe: async () => ({ mediaProgress: [] }),
        downloadUrlForTrack: (_id, track) => `http://abs.local${track.contentUrl}`,
      }),
      getServer: () => server,
    });

    await manager.queueBook({ appService, book });
    await vi.waitFor(() => expect(useAbsMediaStore.getState().itemOf('h1')?.status).toBe('failed'));
    const snap = await readSnapshot(appService, 'h1');
    expect(snap?.tracks.some((t) => t.complete)).toBe(false);
    expect(useAbsMediaStore.getState().presenceOf('h1')?.complete).not.toBe(true);
  });

  it('records byte progress while a track downloads', async () => {
    const { appService, files } = makeFs();
    const seen: { done: number; total: number }[] = [];
    const downloadTrack = vi.fn(
      async (input: {
        destAbsPath: string;
        url: string;
        headers: Record<string, string>;
        onProgress: (p: { progress: number; total?: number }) => void;
      }) => {
        const size = input.url.endsWith('/a') ? 10 : 20;
        input.onProgress({ progress: 0.5, total: size });
        const job = useAbsMediaStore.getState().itemOf('h1')!;
        seen.push({ done: job.doneBytes, total: job.totalBytes });
        files.set(input.destAbsPath, 'x'.repeat(size));
        input.onProgress({ progress: 1, total: size });
      },
    );
    const manager = new AbsMediaDownloadManager({
      downloadTrack,
      resolveAbsPath: async (rel) => rel,
      exists: appService.exists.bind(appService),
      stats: appService.stats.bind(appService),
      createDir: appService.createDir.bind(appService),
      deleteFile: appService.deleteFile.bind(appService),
      deleteDir: appService.deleteDir.bind(appService),
      copyFile: appService.copyFile.bind(appService),
      writeSnapshot,
      readSnapshot,
      isTauri: () => true,
      getClient: () => ({
        getItemExpanded: async () => twoTrackItem,
        getMe: async () => ({ mediaProgress: [] }),
        downloadUrlForTrack: (_id, track) => `http://abs.local${track.contentUrl}`,
      }),
      getServer: () => server,
    });

    await manager.queueBook({ appService, book });
    expect(seen[0]?.total).toBe(30);
    expect(seen[0]?.done).toBeGreaterThan(0);
  });

  it('uses onProgress total when the snapshot has no track sizes', async () => {
    const { appService, files } = makeFs();
    const item: ABSLibraryItem = {
      ...twoTrackItem,
      media: {
        ...twoTrackItem.media,
        tracks: twoTrackItem.media.tracks!.map(({ size: _size, ...track }) => track),
      },
    };
    const downloadTrack = vi.fn(
      async (input: {
        destAbsPath: string;
        url: string;
        headers: Record<string, string>;
        onProgress: (p: { progress: number; total?: number }) => void;
      }) => {
        files.set(input.destAbsPath, 'x'.repeat(12));
        input.onProgress({ progress: 1, total: 12 });
      },
    );
    const manager = new AbsMediaDownloadManager({
      downloadTrack,
      resolveAbsPath: async (rel) => rel,
      exists: appService.exists.bind(appService),
      stats: appService.stats.bind(appService),
      createDir: appService.createDir.bind(appService),
      deleteFile: appService.deleteFile.bind(appService),
      deleteDir: appService.deleteDir.bind(appService),
      copyFile: appService.copyFile.bind(appService),
      writeSnapshot,
      readSnapshot,
      isTauri: () => true,
      getClient: () => ({
        getItemExpanded: async () => item,
        getMe: async () => ({ mediaProgress: [] }),
        downloadUrlForTrack: (_id, track) => `http://abs.local${track.contentUrl}`,
      }),
      getServer: () => server,
    });

    await manager.queueBook({ appService, book });
    await vi.waitFor(() =>
      expect(useAbsMediaStore.getState().presenceOf('h1')?.complete).toBe(true),
    );
  });

  it('retries a failed job without a second getItemExpanded', async () => {
    const { appService, files } = makeFs();
    let attempts = 0;
    const downloadTrack = vi.fn(
      async (input: {
        destAbsPath: string;
        url: string;
        headers: Record<string, string>;
        onProgress: (p: { progress: number; total?: number }) => void;
      }) => {
        attempts += 1;
        if (attempts === 1) throw new Error('network');
        const size = input.url.endsWith('/a') ? 10 : 20;
        files.set(input.destAbsPath, 'x'.repeat(size));
        input.onProgress({ progress: 1, total: size });
      },
    );
    const getItemExpanded = vi.fn(async () => twoTrackItem);
    const manager = new AbsMediaDownloadManager({
      downloadTrack,
      resolveAbsPath: async (rel) => rel,
      exists: appService.exists.bind(appService),
      stats: appService.stats.bind(appService),
      createDir: appService.createDir.bind(appService),
      deleteFile: appService.deleteFile.bind(appService),
      deleteDir: appService.deleteDir.bind(appService),
      copyFile: appService.copyFile.bind(appService),
      writeSnapshot,
      readSnapshot,
      isTauri: () => true,
      getClient: () => ({
        getItemExpanded,
        getMe: async () => ({ mediaProgress: [] }),
        downloadUrlForTrack: (_id, track) => `http://abs.local${track.contentUrl}`,
      }),
      getServer: () => server,
    });

    await manager.queueBook({ appService, book });
    await vi.waitFor(() => expect(useAbsMediaStore.getState().itemOf('h1')?.status).toBe('failed'));
    await manager.retry('h1');
    await vi.waitFor(() =>
      expect(useAbsMediaStore.getState().presenceOf('h1')?.complete).toBe(true),
    );
    expect(getItemExpanded).toHaveBeenCalledTimes(1);
  });

  it('queueBook on a podcast enqueues every episode', async () => {
    const { appService, files } = makeFs();
    const second: ABSEpisode = {
      id: 'ep2',
      title: 'Episode Two',
      duration: 10,
      audioTrack: {
        index: 1,
        startOffset: 0,
        duration: 10,
        contentUrl: '/api/items/item1/file/ep2',
        mimeType: 'audio/mpeg',
        ino: 'ep2',
        size: 8,
      },
    };
    const show: ABSLibraryItem = {
      ...podcastItem,
      media: { ...podcastItem.media, episodes: [episode, second] },
    };
    const downloadTrack = vi.fn(
      async (input: {
        destAbsPath: string;
        url: string;
        headers: Record<string, string>;
        onProgress: (p: { progress: number; total?: number }) => void;
      }) => {
        files.set(input.destAbsPath, 'x'.repeat(8));
        input.onProgress({ progress: 1, total: 8 });
      },
    );
    const manager = new AbsMediaDownloadManager({
      downloadTrack,
      resolveAbsPath: async (rel) => rel,
      exists: appService.exists.bind(appService),
      stats: appService.stats.bind(appService),
      createDir: appService.createDir.bind(appService),
      deleteFile: appService.deleteFile.bind(appService),
      deleteDir: appService.deleteDir.bind(appService),
      copyFile: appService.copyFile.bind(appService),
      writeSnapshot,
      readSnapshot,
      isTauri: () => true,
      getClient: () => ({
        getItemExpanded: async () => show,
        getMe: async () => ({ mediaProgress: [] }),
        downloadUrlForTrack: (_id, track) => `http://abs.local${track.contentUrl}`,
      }),
      getServer: () => server,
    });

    await manager.queueBook({ appService, book: { ...book, absMediaType: 'podcast' } });
    await vi.waitFor(() => {
      expect(useAbsMediaStore.getState().presenceOf('h1', 'ep1')?.complete).toBe(true);
      expect(useAbsMediaStore.getState().presenceOf('h1', 'ep2')?.complete).toBe(true);
    });
  });
});

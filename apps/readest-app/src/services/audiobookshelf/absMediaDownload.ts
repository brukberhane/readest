import { AbsMediaDownloadManager } from '@/services/audiobookshelf/mediaDownloadManager';
import { createAbsClient } from '@/services/audiobookshelf/createClient';
import { readSnapshot, writeSnapshot } from '@/services/audiobookshelf/playbackSnapshot';
import { findABSServerById } from '@/store/absServerStore';
import { isTauriAppPlatform } from '@/services/environment';
import { tauriDownload } from '@/utils/transfer';
import type { AppService } from '@/types/system';
import type { Book } from '@/types/book';
import type { ABSEpisode } from '@/types/audiobookshelf';

let boundAppService: AppService | null = null;

const requireAppService = (): AppService => {
  if (!boundAppService) throw new Error('ABS media download is not bound to an AppService');
  return boundAppService;
};

const bind = (appService: AppService): void => {
  boundAppService = appService;
};

const manager = new AbsMediaDownloadManager({
  downloadTrack: async (input) => {
    await tauriDownload(
      input.url,
      input.destAbsPath,
      (payload) => {
        input.onProgress({
          progress: payload.total > 0 ? payload.progress / payload.total : 0,
          total: payload.total,
        });
      },
      input.headers,
      undefined,
      undefined,
      true,
    );
  },
  resolveAbsPath: (rel) => requireAppService().resolveFilePath(rel, 'Books'),
  exists: (path, base) => requireAppService().exists(path, base),
  stats: (path, base) => requireAppService().stats(path, base),
  createDir: (path, base, recursive) => requireAppService().createDir(path, base, recursive),
  deleteFile: (path, base) => requireAppService().deleteFile(path, base),
  deleteDir: (path, base, recursive) => requireAppService().deleteDir(path, base, recursive),
  copyFile: (src, srcBase, dst, dstBase) =>
    requireAppService().copyFile(src, srcBase, dst, dstBase),
  writeSnapshot,
  readSnapshot,
  isTauri: () => isTauriAppPlatform(),
  getClient: (server) => createAbsClient(requireAppService(), server),
  getServer: (serverId) => findABSServerById(serverId),
});

export const absMediaDownloadManager = {
  queueBook: async (input: { appService: AppService; book: Book }) => {
    bind(input.appService);
    return manager.queueBook(input);
  },
  queueEpisode: async (input: { appService: AppService; book: Book; episode: ABSEpisode }) => {
    bind(input.appService);
    return manager.queueEpisode(input);
  },
  cancel: (id: string) => manager.cancel(id),
  removeDownload: async (input: {
    appService: AppService;
    bookHash: string;
    episodeId?: string;
  }) => {
    bind(input.appService);
    return manager.removeDownload(input);
  },
};

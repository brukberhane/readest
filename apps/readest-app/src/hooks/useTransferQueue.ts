import { useEffect, useCallback, useMemo } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from './useTranslation';
import { useLibraryStore } from '@/store/libraryStore';
import { useTransferStore, TransferType, isFailedLikeTransfer } from '@/store/transferStore';
import { transferManager } from '@/services/transferManager';
import { absMediaDownloadManager } from '@/services/audiobookshelf/absMediaDownload';
import { useAbsMediaStore } from '@/store/absMediaStore';
import {
  absJobToTransferItem,
  absMediaJobIdFromTransferId,
  isAbsMediaTransferId,
} from '@/utils/absMediaProgress';
import { Book } from '@/types/book';

// The `libraryLoaded = true` default lets surfaces like SettingsMenu and
// TransferQueuePanel initialize the manager on mount, before settings
// hydrate. That is safe: the manager defers book uploads until
// settings.version is truthy and reconciles them against the selected
// cloud sync provider once it is (see transferManager.isSettingsLoaded).
export function useTransferQueue(libraryLoaded = true, delayInit = 0) {
  const { envConfig, appService } = useEnv();
  const _ = useTranslation();

  const transfers = useTransferStore((state) => state.transfers);
  const absItems = useAbsMediaStore((state) => state.items);
  const isQueuePaused = useTransferStore((state) => state.isQueuePaused);
  const setIsTransferQueueOpen = useTransferStore((state) => state.setIsTransferQueueOpen);

  useEffect(() => {
    const initManager = async () => {
      if (appService && envConfig) {
        const getLibrary = () => useLibraryStore.getState().library;
        const updateBookFn = async (book: Book) => {
          await useLibraryStore.getState().updateBook(envConfig, book);
        };
        const translationFn = _;
        await transferManager.initialize(appService, getLibrary, updateBookFn, translationFn);
        absMediaDownloadManager.hydrate(appService);
      }
    };

    // Initialize transfer manager only when library is loaded
    if (libraryLoaded) {
      setTimeout(() => {
        initManager();
      }, delayInit);
    }
  }, [appService, envConfig, libraryLoaded, delayInit, _]);

  const queueUpload = useCallback((book: Book, priority?: number) => {
    return transferManager.queueUpload(book, priority);
  }, []);

  const queueDownload = useCallback((book: Book, priority?: number) => {
    return transferManager.queueDownload(book, priority);
  }, []);

  const queueBatchUploads = useCallback((books: Book[], priority?: number) => {
    return transferManager.queueBatchUploads(books, priority);
  }, []);

  const cancelTransfer = useCallback((transferId: string) => {
    if (isAbsMediaTransferId(transferId)) {
      absMediaDownloadManager.cancel(absMediaJobIdFromTransferId(transferId));
      return;
    }
    transferManager.cancelTransfer(transferId);
  }, []);

  const retryTransfer = useCallback(
    (transferId: string) => {
      if (isAbsMediaTransferId(transferId)) {
        void absMediaDownloadManager.retry(
          absMediaJobIdFromTransferId(transferId),
          appService ?? undefined,
        );
        return;
      }
      transferManager.retryTransfer(transferId);
    },
    [appService],
  );

  const retryAllFailed = useCallback(() => {
    transferManager.retryAllFailed();
    void absMediaDownloadManager.retryAllFailed(appService ?? undefined);
  }, [appService]);

  const pauseQueue = useCallback(() => {
    transferManager.pauseQueue();
  }, []);

  const resumeQueue = useCallback(() => {
    transferManager.resumeQueue();
  }, []);

  const clearCompleted = useCallback(() => {
    transferManager.clearCompleted();
  }, []);

  const clearFailed = useCallback(() => {
    transferManager.clearFailed();
    absMediaDownloadManager.clearFailed();
  }, []);

  const clearPending = useCallback(() => {
    transferManager.clearPending();
    absMediaDownloadManager.clearPending();
  }, []);

  const clearAll = useCallback(() => {
    transferManager.clearAll();
    absMediaDownloadManager.clearPending();
    absMediaDownloadManager.clearFailed();
  }, []);

  const getTransferProgress = useCallback((bookHash: string, type: TransferType) => {
    return useTransferStore.getState().getTransferByBookHash(bookHash, type);
  }, []);

  const allTransfers = useMemo(
    () => [...Object.values(transfers), ...Object.values(absItems).map(absJobToTransferItem)],
    [transfers, absItems],
  );

  const stats = useMemo(() => {
    return {
      pending: allTransfers.filter((t) => t.status === 'pending').length,
      active: allTransfers.filter((t) => t.status === 'in_progress').length,
      completed: allTransfers.filter((t) => t.status === 'completed').length,
      failed: allTransfers.filter(isFailedLikeTransfer).length,
      total: allTransfers.length,
    };
  }, [allTransfers]);

  const pendingTransfers = useMemo(() => {
    return allTransfers.filter((t) => t.status === 'pending');
  }, [allTransfers]);

  const activeTransfers = useMemo(() => {
    return allTransfers.filter((t) => t.status === 'in_progress');
  }, [allTransfers]);

  const failedTransfers = useMemo(() => {
    return allTransfers.filter(isFailedLikeTransfer);
  }, [allTransfers]);

  const completedTransfers = useMemo(() => {
    return allTransfers.filter((t) => t.status === 'completed');
  }, [allTransfers]);

  const hasActiveTransfers = useMemo(() => {
    return pendingTransfers.length > 0 || activeTransfers.length > 0;
  }, [pendingTransfers, activeTransfers]);

  return {
    transfers: allTransfers,
    isQueuePaused,
    stats,
    pendingTransfers,
    activeTransfers,
    failedTransfers,
    completedTransfers,
    hasActiveTransfers,

    setIsTransferQueueOpen,
    queueUpload,
    queueDownload,
    queueBatchUploads,
    cancelTransfer,
    retryTransfer,
    retryAllFailed,
    pauseQueue,
    resumeQueue,
    clearCompleted,
    clearFailed,
    clearPending,
    clearAll,
    getTransferProgress,
  };
}

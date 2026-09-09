import { INDETERMINATE_PROGRESS } from '@/utils/transfer';
import type { AbsMediaJob } from '@/store/absMediaStore';
import type { TransferItem } from '@/store/transferStore';

export const ABS_MEDIA_TRANSFER_PREFIX = 'abs-media:';

export const isAbsMediaTransferId = (id: string): boolean =>
  id.startsWith(ABS_MEDIA_TRANSFER_PREFIX);

export const absMediaJobIdFromTransferId = (id: string): string =>
  id.slice(ABS_MEDIA_TRANSFER_PREFIX.length);

export const absJobProgressPercent = (job: AbsMediaJob): number => {
  if (job.totalBytes > 0) {
    return Math.min(100, Math.round((job.doneBytes / job.totalBytes) * 100));
  }
  return INDETERMINATE_PROGRESS;
};

export const absJobToTransferItem = (job: AbsMediaJob): TransferItem => ({
  id: `${ABS_MEDIA_TRANSFER_PREFIX}${job.id}`,
  kind: 'book',
  bookHash: job.bookHash,
  bookTitle: job.label,
  type: 'download',
  status: job.status,
  progress: absJobProgressPercent(job),
  totalBytes: job.totalBytes,
  transferredBytes: job.doneBytes,
  transferSpeed: 0,
  error: job.error,
  retryCount: 0,
  maxRetries: 0,
  createdAt: job.createdAt,
  startedAt: job.startedAt,
  priority: job.priority,
  isBackground: false,
});

export const selectAbsDownloadProgress = (
  items: Record<string, AbsMediaJob>,
): Record<string, number> => {
  const progress: Record<string, number> = {};
  const groups = new Map<string, AbsMediaJob[]>();
  for (const job of Object.values(items)) {
    if (job.status !== 'pending' && job.status !== 'in_progress') continue;
    const list = groups.get(job.bookHash) ?? [];
    list.push(job);
    groups.set(job.bookHash, list);
  }
  for (const [hash, jobs] of groups) {
    const chosen = jobs.find((job) => job.status === 'in_progress') ?? jobs[0]!;
    progress[hash] = absJobProgressPercent(chosen);
  }
  return progress;
};

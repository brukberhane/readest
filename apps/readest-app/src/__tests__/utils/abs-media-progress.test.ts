import { describe, expect, it } from 'vitest';
import { INDETERMINATE_PROGRESS } from '@/utils/transfer';
import type { AbsMediaJob } from '@/store/absMediaStore';
import {
  ABS_MEDIA_TRANSFER_PREFIX,
  absJobProgressPercent,
  absJobToTransferItem,
  absMediaJobIdFromTransferId,
  isAbsMediaTransferId,
  selectAbsDownloadProgress,
} from '@/utils/absMediaProgress';

const job = (over: Partial<AbsMediaJob> = {}): AbsMediaJob => ({
  id: 'h1',
  bookHash: 'h1',
  itemId: 'item1',
  serverId: 'srv1',
  label: 'Pride',
  status: 'in_progress',
  doneBytes: 0,
  totalBytes: 0,
  createdAt: 1,
  priority: 10,
  ...over,
});

describe('absMediaProgress', () => {
  it('reports percent when totalBytes is known', () => {
    expect(absJobProgressPercent(job({ doneBytes: 25, totalBytes: 100 }))).toBe(25);
  });

  it('reports indeterminate when the byte total is unknown', () => {
    expect(absJobProgressPercent(job({ doneBytes: 10, totalBytes: 0 }))).toBe(
      INDETERMINATE_PROGRESS,
    );
  });

  it('maps a job onto a transfer-queue row with a prefixed id', () => {
    const row = absJobToTransferItem(job({ doneBytes: 40, totalBytes: 80 }));
    expect(row.id).toBe(`${ABS_MEDIA_TRANSFER_PREFIX}h1`);
    expect(isAbsMediaTransferId(row.id)).toBe(true);
    expect(absMediaJobIdFromTransferId(row.id)).toBe('h1');
    expect(row.type).toBe('download');
    expect(row.progress).toBe(50);
    expect(row.bookTitle).toBe('Pride');
  });

  it('keeps indeterminate progress on the queue row when the byte total is unknown', () => {
    expect(absJobToTransferItem(job()).progress).toBe(INDETERMINATE_PROGRESS);
  });

  it('aggregates in-progress jobs onto the library cover by book hash', () => {
    expect(
      selectAbsDownloadProgress({
        a: job({ id: 'h1', bookHash: 'h1', status: 'in_progress', doneBytes: 50, totalBytes: 100 }),
        b: job({
          id: 'h2:ep',
          bookHash: 'h2',
          episodeId: 'ep',
          status: 'pending',
          doneBytes: 0,
          totalBytes: 0,
        }),
        c: job({ id: 'h3', bookHash: 'h3', status: 'failed', doneBytes: 1, totalBytes: 10 }),
      }),
    ).toEqual({
      h1: 50,
      h2: INDETERMINATE_PROGRESS,
    });
  });
});

import { useState } from 'react';
import type { AppService } from '@/types/system';
import type { Book } from '@/types/book';
import { absMediaDownloadManager } from '@/services/audiobookshelf/absMediaDownload';
import { absMediaJobId, useAbsMediaStore } from '@/store/absMediaStore';
import { useTranslation } from '@/hooks/useTranslation';
import { formatBytes } from '@/utils/book';
import { loadAbsEpisodes } from '@/services/audiobook/openAudiobook';
import Dialog from '@/components/Dialog';

interface AbsOfflineControlsProps {
  book: Book;
  episodeId?: string;
  appService: AppService | null;
  getAppService: () => Promise<AppService>;
}

const AbsOfflineControls = ({
  book,
  episodeId,
  appService,
  getAppService,
}: AbsOfflineControlsProps) => {
  const _ = useTranslation();
  const jobId = absMediaJobId(book.hash, episodeId);
  const job = useAbsMediaStore((s) => s.items[jobId]);
  const presence = useAbsMediaStore((s) => s.presence[jobId]);
  const [confirm, setConfirm] = useState<'download' | 'remove' | null>(null);

  const resolveService = async (): Promise<AppService> => appService ?? (await getAppService());

  const queue = async () => {
    const svc = await resolveService();
    if (episodeId) {
      const loaded = await loadAbsEpisodes(svc, book);
      const episode = loaded?.episodes.find((entry) => entry.id === episodeId);
      if (!episode) return;
      await absMediaDownloadManager.queueEpisode({ appService: svc, book, episode });
    } else {
      await absMediaDownloadManager.queueBook({ appService: svc, book });
    }
  };

  const handlePrimary = () => {
    if (job?.status === 'in_progress' || job?.status === 'pending') {
      absMediaDownloadManager.cancel(jobId);
      return;
    }
    if (presence?.complete) return;
    setConfirm('download');
  };

  const confirmDownload = async () => {
    setConfirm(null);
    await queue();
  };

  const confirmRemove = async () => {
    setConfirm(null);
    const svc = await resolveService();
    await absMediaDownloadManager.removeDownload({
      appService: svc,
      bookHash: book.hash,
      episodeId,
    });
  };

  const percent =
    job && job.totalBytes > 0 ? Math.round((job.doneBytes / job.totalBytes) * 100) : null;
  const busy = job?.status === 'in_progress' || job?.status === 'pending';
  const complete = !!presence?.complete;
  const sizeLabel = formatBytes(job?.totalBytes || presence?.bytes || 0);
  const downloadCopy = episodeId
    ? sizeLabel
      ? _('Download this episode? It will use about {{size}}.', { size: sizeLabel })
      : _('Download this episode for offline playback?')
    : sizeLabel
      ? _('Download this audiobook? It will use about {{size}}.', { size: sizeLabel })
      : _('Download this audiobook for offline playback?');

  const primaryLabel = busy
    ? percent != null
      ? _('Downloading {{percent}}%', { percent })
      : _('Downloading')
    : complete
      ? _('Downloaded')
      : _('Download');

  return (
    <>
      <div className='flex w-full max-w-md flex-col gap-2'>
        <button
          type='button'
          aria-label={primaryLabel}
          onClick={handlePrimary}
          className='not-eink:bg-base-200 eink-bordered flex h-14 min-w-0 w-full flex-col items-center justify-center gap-0.5 rounded-xl'
        >
          <span className='text-sm font-semibold'>{primaryLabel}</span>
        </button>
        {complete && (
          <button
            type='button'
            aria-label={_('Remove Download')}
            onClick={() => setConfirm('remove')}
            className='btn btn-ghost h-10 min-h-10 w-full'
          >
            {_('Remove Download')}
          </button>
        )}
      </div>
      <Dialog
        id='abs_offline_confirm'
        isOpen={confirm !== null}
        onClose={() => setConfirm(null)}
        title={
          confirm === 'remove'
            ? _('Remove Download')
            : episodeId
              ? _('Download this episode for offline playback?')
              : _('Download this audiobook for offline playback?')
        }
      >
        <p className='text-start text-sm'>
          {confirm === 'remove' ? _('Remove downloaded audio?') : downloadCopy}
        </p>
        <div className='mt-4 flex justify-end gap-2'>
          <button type='button' className='btn btn-ghost' onClick={() => setConfirm(null)}>
            {_('Cancel')}
          </button>
          <button
            type='button'
            className='btn btn-contrast'
            onClick={() => void (confirm === 'remove' ? confirmRemove() : confirmDownload())}
          >
            {confirm === 'remove' ? _('Remove Download') : _('Download')}
          </button>
        </div>
      </Dialog>
    </>
  );
};

export default AbsOfflineControls;

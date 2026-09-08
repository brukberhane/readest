import clsx from 'clsx';
import { MdCheckCircle, MdGraphicEq, MdFileDownload, MdOfflinePin } from 'react-icons/md';

import type { ABSEpisode, ABSMediaProgress } from '@/types/audiobookshelf';
import { useTranslation } from '@/hooks/useTranslation';
import { formatPlaybackTime } from '@/utils/time';

export type EpisodeDownloadStatus = {
  complete: boolean;
  inProgress: boolean;
};

interface EpisodesViewProps {
  episodes: ABSEpisode[];
  progressByEpisodeId: Map<string, ABSMediaProgress>;
  /** The episode currently playing in this show's live session, if any. */
  activeEpisodeId?: string;
  /** The episode just tapped, whose claim hasn't landed yet. */
  pendingEpisodeId?: string;
  onSelectEpisode: (episode: ABSEpisode) => void;
  onDownloadEpisode?: (episode: ABSEpisode) => void;
  onRemoveEpisode?: (episode: ABSEpisode) => void;
  downloadStatusById?: Map<string, EpisodeDownloadStatus>;
}

// A progress row counts as finished either by the server's own flag or by
// having played past effectively the whole thing - mirrors how a scrubber
// at 99%+ reads as "done" to a listener, and guards against a duration that
// never quite matches currentTime exactly.
const isEpisodeFinished = (progress?: ABSMediaProgress): boolean => {
  if (!progress) return false;
  if (progress.isFinished) return true;
  return progress.duration > 0 && progress.currentTime / progress.duration >= 0.99;
};

const EpisodesView = ({
  episodes,
  progressByEpisodeId,
  activeEpisodeId,
  pendingEpisodeId,
  onSelectEpisode,
  onDownloadEpisode,
  onRemoveEpisode,
  downloadStatusById,
}: EpisodesViewProps) => {
  const _ = useTranslation();

  if (episodes.length === 0) {
    return (
      <div className='text-base-content/60 flex w-full flex-1 items-center justify-center px-4 py-8 text-center text-sm'>
        {_('No episodes found')}
      </div>
    );
  }

  return (
    <div className='flex w-full max-w-md flex-col'>
      {episodes.map((episode) => {
        const isActive = episode.id === activeEpisodeId;
        const isPending = episode.id === pendingEpisodeId;
        const progress = progressByEpisodeId.get(episode.id);
        const finished = isEpisodeFinished(progress);
        const percent =
          !finished && progress && progress.duration > 0
            ? Math.round((progress.currentTime / progress.duration) * 100)
            : null;
        const duration = episode.duration ?? episode.audioTrack?.duration ?? 0;

        return (
          <div
            key={episode.id}
            role='button'
            tabIndex={0}
            aria-busy={isPending}
            onClick={() => onSelectEpisode(episode)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelectEpisode(episode);
              }
            }}
            className={clsx(
              'flex w-full flex-col gap-0.5 rounded-lg px-2 py-2.5 text-start',
              (isActive || isPending) && 'eink-bordered not-eink:bg-base-200',
            )}
          >
            <div className='flex w-full items-center gap-2'>
              {isActive && (
                <MdGraphicEq className='text-base-content shrink-0' aria-label={_('Now playing')} />
              )}
              <span
                className={clsx('line-clamp-1 min-w-0 flex-1 text-sm', isActive && 'font-semibold')}
              >
                {episode.title}
              </span>
              {isPending && (
                <span
                  aria-hidden='true'
                  className='loading loading-xs not-eink:loading-dots eink:loading-spinner shrink-0'
                />
              )}
              {onDownloadEpisode &&
                (downloadStatusById?.get(episode.id)?.complete ? (
                  <button
                    type='button'
                    aria-label={_('Remove Download')}
                    className='btn btn-ghost btn-xs shrink-0'
                    onClick={(event) => {
                      event.stopPropagation();
                      onRemoveEpisode?.(episode);
                    }}
                  >
                    <MdOfflinePin />
                  </button>
                ) : (
                  <button
                    type='button'
                    aria-label={_('Download')}
                    className='btn btn-ghost btn-xs shrink-0'
                    onClick={(event) => {
                      event.stopPropagation();
                      onDownloadEpisode(episode);
                    }}
                  >
                    <MdFileDownload />
                  </button>
                ))}
            </div>
            <div className='text-base-content/60 flex w-full items-center gap-2 text-xs tabular-nums'>
              {episode.publishedAt != null && (
                <span>{new Date(episode.publishedAt).toLocaleDateString()}</span>
              )}
              <span>{formatPlaybackTime(duration)}</span>
              {finished ? (
                <MdCheckCircle aria-label={_('Played')} />
              ) : (
                percent !== null && <span>{percent}%</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default EpisodesView;

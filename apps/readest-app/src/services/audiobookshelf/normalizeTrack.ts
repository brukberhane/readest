import type { ABSEpisode, ABSLibraryItem, ABSTrack } from '@/types/audiobookshelf';

type AbsTrackLike = ABSTrack & {
  metadata?: { size?: number };
  audioFile?: { ino?: string; metadata?: { size?: number } };
};

export const normalizeAbsTrack = (raw: ABSTrack): ABSTrack => {
  const extra = raw as AbsTrackLike;
  const size = raw.size ?? extra.metadata?.size ?? extra.audioFile?.metadata?.size;
  const ino = raw.ino ?? extra.audioFile?.ino;
  return {
    ...raw,
    ...(ino ? { ino } : {}),
    ...(size != null ? { size } : {}),
  };
};

export const normalizeAbsItem = (item: ABSLibraryItem): ABSLibraryItem => ({
  ...item,
  media: {
    ...item.media,
    tracks: item.media.tracks?.map(normalizeAbsTrack),
    episodes: item.media.episodes?.map(
      (episode): ABSEpisode => ({
        ...episode,
        ...(episode.audioTrack ? { audioTrack: normalizeAbsTrack(episode.audioTrack) } : {}),
      }),
    ),
  },
});

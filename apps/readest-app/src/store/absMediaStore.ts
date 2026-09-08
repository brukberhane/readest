import { create } from 'zustand';

export type AbsMediaJobStatus = 'pending' | 'in_progress' | 'failed';

export interface AbsMediaJob {
  id: string;
  bookHash: string;
  episodeId?: string;
  itemId: string;
  serverId: string;
  label: string;
  status: AbsMediaJobStatus;
  doneBytes: number;
  totalBytes: number;
  error?: string;
  createdAt: number;
  startedAt?: number;
  priority: number;
}

export interface AbsMediaPresence {
  bookHash: string;
  episodeId?: string;
  complete: boolean;
  bytes: number;
}

export const absMediaJobId = (bookHash: string, episodeId?: string): string =>
  episodeId ? `${bookHash}:${episodeId}` : bookHash;

interface AbsMediaState {
  items: Record<string, AbsMediaJob>;
  presence: Record<string, AbsMediaPresence>;

  enqueue: (input: {
    bookHash: string;
    episodeId?: string;
    itemId: string;
    serverId: string;
    label: string;
    priority?: number;
  }) => string;
  removeItem: (id: string) => void;
  setInProgress: (id: string) => void;
  updateProgress: (id: string, doneBytes: number, totalBytes: number) => void;
  setFailed: (id: string, error?: string) => void;
  setPresence: (id: string, presence: AbsMediaPresence) => void;
  itemOf: (bookHash: string, episodeId?: string) => AbsMediaJob | undefined;
  presenceOf: (bookHash: string, episodeId?: string) => AbsMediaPresence | undefined;
  restoreItems: (items: Record<string, AbsMediaJob>) => void;
  restorePresence: (presence: Record<string, AbsMediaPresence>) => void;
}

export const useAbsMediaStore = create<AbsMediaState>((set, get) => ({
  items: {},
  presence: {},

  enqueue: (input) => {
    const id = absMediaJobId(input.bookHash, input.episodeId);
    const item: AbsMediaJob = {
      id,
      bookHash: input.bookHash,
      itemId: input.itemId,
      serverId: input.serverId,
      label: input.label,
      status: 'pending',
      doneBytes: 0,
      totalBytes: 0,
      createdAt: Date.now(),
      priority: input.priority ?? 10,
      ...(input.episodeId ? { episodeId: input.episodeId } : {}),
    };
    set((state) => ({ items: { ...state.items, [id]: item } }));
    return id;
  },

  removeItem: (id) => {
    set((state) => {
      if (!state.items[id]) return state;
      const { [id]: _, ...remaining } = state.items;
      return { items: remaining };
    });
  },

  setInProgress: (id) => {
    set((state) => {
      const item = state.items[id];
      if (!item || item.status === 'in_progress') return state;
      return {
        items: {
          ...state.items,
          [id]: { ...item, status: 'in_progress', startedAt: Date.now() },
        },
      };
    });
  },

  updateProgress: (id, doneBytes, totalBytes) => {
    set((state) => {
      const item = state.items[id];
      if (!item) return state;
      return {
        items: { ...state.items, [id]: { ...item, doneBytes, totalBytes } },
      };
    });
  },

  setFailed: (id, error) => {
    set((state) => {
      const item = state.items[id];
      if (!item) return state;
      return {
        items: { ...state.items, [id]: { ...item, status: 'failed', error } },
      };
    });
  },

  setPresence: (id, presence) => {
    set((state) => ({ presence: { ...state.presence, [id]: presence } }));
  },

  itemOf: (bookHash, episodeId) => get().items[absMediaJobId(bookHash, episodeId)],
  presenceOf: (bookHash, episodeId) => get().presence[absMediaJobId(bookHash, episodeId)],

  restoreItems: (items) => {
    const restored: Record<string, AbsMediaJob> = {};
    for (const item of Object.values(items)) {
      if (item.status === 'pending') {
        restored[item.id] = item;
      } else if (item.status === 'in_progress') {
        restored[item.id] = { ...item, status: 'pending', doneBytes: 0, totalBytes: 0 };
      } else if (item.status === 'failed') {
        restored[item.id] = item;
      }
    }
    set({ items: restored });
  },

  restorePresence: (presence) => set({ presence }),
}));

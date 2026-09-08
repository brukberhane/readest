import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { useAbsMediaStore, type AbsMediaJob } from '@/store/absMediaStore';

describe('useAbsMediaStore', () => {
  beforeEach(() => {
    useAbsMediaStore.setState({ items: {}, presence: {} });
  });

  afterEach(() => {
    useAbsMediaStore.setState({ items: {}, presence: {} });
  });

  test('enqueue adds a pending row keyed by bookHash (and episodeId)', () => {
    const store = useAbsMediaStore.getState();
    const id = store.enqueue({
      bookHash: 'h1',
      itemId: 'item1',
      serverId: 'srv1',
      label: 'Pride',
    });
    expect(id).toBe('h1');
    expect(store.itemOf('h1')).toMatchObject({
      status: 'pending',
      doneBytes: 0,
      totalBytes: 0,
      label: 'Pride',
    });
    const epId = store.enqueue({
      bookHash: 'h1',
      episodeId: 'ep1',
      itemId: 'item1',
      serverId: 'srv1',
      label: 'Episode One',
    });
    expect(epId).toBe('h1:ep1');
    expect(store.itemOf('h1', 'ep1')?.label).toBe('Episode One');
    expect(store.itemOf('h1')?.label).toBe('Pride');
  });

  test('removeItem drops only the targeted row', () => {
    const store = useAbsMediaStore.getState();
    store.enqueue({ bookHash: 'h1', itemId: 'i', serverId: 's', label: 'A' });
    store.enqueue({
      bookHash: 'h1',
      episodeId: 'ep1',
      itemId: 'i',
      serverId: 's',
      label: 'B',
    });
    store.removeItem('h1');
    expect(store.itemOf('h1')).toBeUndefined();
    expect(store.itemOf('h1', 'ep1')).toBeDefined();
  });

  test('status transitions: in_progress records startedAt, progress updates, failed records error', () => {
    const store = useAbsMediaStore.getState();
    store.enqueue({ bookHash: 'h1', itemId: 'i', serverId: 's', label: 'A' });
    store.setInProgress('h1');
    expect(store.itemOf('h1')?.status).toBe('in_progress');
    expect(store.itemOf('h1')?.startedAt).toBeTypeOf('number');
    store.updateProgress('h1', 3, 10);
    expect(store.itemOf('h1')).toMatchObject({ doneBytes: 3, totalBytes: 10 });
    store.setFailed('h1', 'boom');
    expect(store.itemOf('h1')).toMatchObject({ status: 'failed', error: 'boom' });
  });

  test('setPresence is readable via presenceOf', () => {
    const store = useAbsMediaStore.getState();
    store.setPresence('h1', { bookHash: 'h1', complete: true, bytes: 99 });
    store.setPresence('h1:ep1', {
      bookHash: 'h1',
      episodeId: 'ep1',
      complete: false,
      bytes: 1,
    });
    expect(store.presenceOf('h1')).toEqual({ bookHash: 'h1', complete: true, bytes: 99 });
    expect(store.presenceOf('h1', 'ep1')?.complete).toBe(false);
  });

  test('restoreItems demotes interrupted runs to pending and drops unknown statuses', () => {
    const store = useAbsMediaStore.getState();
    store.restoreItems({
      h1: {
        id: 'h1',
        bookHash: 'h1',
        itemId: 'i',
        serverId: 's',
        label: 'A',
        status: 'pending',
        doneBytes: 0,
        totalBytes: 0,
        createdAt: 1,
        priority: 10,
      },
      h2: {
        id: 'h2',
        bookHash: 'h2',
        itemId: 'i',
        serverId: 's',
        label: 'B',
        status: 'in_progress',
        doneBytes: 7,
        totalBytes: 10,
        createdAt: 2,
        priority: 10,
      },
      h3: {
        id: 'h3',
        bookHash: 'h3',
        itemId: 'i',
        serverId: 's',
        label: 'C',
        status: 'failed',
        doneBytes: 1,
        totalBytes: 5,
        createdAt: 3,
        priority: 10,
      },
      h4: {
        id: 'h4',
        bookHash: 'h4',
        itemId: 'i',
        serverId: 's',
        label: 'D',
        status: 'completed' as unknown as AbsMediaJob['status'],
        doneBytes: 5,
        totalBytes: 5,
        createdAt: 4,
        priority: 10,
      },
    });
    expect(store.itemOf('h1')?.status).toBe('pending');
    expect(store.itemOf('h2')).toMatchObject({ status: 'pending', doneBytes: 0, totalBytes: 0 });
    expect(store.itemOf('h3')?.status).toBe('failed');
    expect(store.itemOf('h4')).toBeUndefined();
  });
});

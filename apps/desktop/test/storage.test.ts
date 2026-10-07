import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { emptyDraft, type Draft } from '@drafttracker/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DraftStore } from '../src/storage.js';

function draftWith(draftId: string, startedAt: number, picks = 0): Draft {
  const draft = emptyDraft(draftId, startedAt);
  draft.eventName = 'PremierDraft_FRA_20260929';
  draft.setCode = 'FRA';
  draft.picks = Array.from({ length: picks }, (_, i) => ({
    pack: 1,
    pick: i + 1,
    cardsSeen: [1, 2, 3],
    picked: 1,
    seenAt: startedAt,
    pickedAt: startedAt + 1,
  }));
  return draft;
}

describe('DraftStore', () => {
  let dir: string;
  let store: DraftStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'drafts-'));
    store = new DraftStore(path.join(dir, 'drafts'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a draft', async () => {
    const draft = draftWith('abc-123', 1000, 4);
    draft.status = 'complete';
    await store.save(draft);

    expect(await store.load('abc-123')).toEqual(draft);
  });

  it('returns an empty history when nothing has been saved', async () => {
    expect(await store.list()).toEqual([]);
    expect(await store.load('missing')).toBeNull();
  });

  it('lists drafts newest first, with a summary rather than every pick', async () => {
    await store.save(draftWith('old', 1000, 3));
    await store.save(draftWith('new', 5000, 7));

    const list = await store.list();
    expect(list.map((d) => d.draftId)).toEqual(['new', 'old']);
    expect(list[0]?.capturedPicks).toBe(7);
    expect(list[0]?.confirmedPicks).toBe(7);
    expect(list[0]?.firstPick).toBe(1);
    expect(list[0]?.setCode).toBe('FRA');
    // A summary is meant to be cheap to ship to the renderer.
    expect(list[0]).not.toHaveProperty('picks');
  });

  it('deletes a draft', async () => {
    await store.save(draftWith('gone', 1000));
    await store.remove('gone');
    expect(await store.list()).toEqual([]);
  });

  it('skips corrupt and unrelated files instead of failing the whole list', async () => {
    await store.save(draftWith('good', 2000));

    await writeFile(path.join(store.dir, 'broken.json'), '{ not json', 'utf8');
    await writeFile(path.join(store.dir, 'unrelated.json'), '{"hello":"world"}', 'utf8');
    await writeFile(path.join(store.dir, 'notes.txt'), 'ignore me', 'utf8');

    const list = await store.list();
    expect(list.map((d) => d.draftId)).toEqual(['good']);
  });

  it('keeps in-progress state separate from saved drafts', async () => {
    const live = draftWith('live', 3000, 2);
    await store.saveInProgress(live);

    expect(await store.loadInProgress()).toEqual(live);
    // A draft still being picked must not show up in history.
    expect(await store.list()).toEqual([]);

    await store.clearInProgress();
    expect(await store.loadInProgress()).toBeNull();
  });

  it('survives concurrent saves to the same draft', async () => {
    // A draft finishing fires several saves at once (the draft, then the deck,
    // then clearing in-progress). Unsynchronized temp-file + rename cycles
    // race each other into ENOENT, which is exactly the bug this guards.
    const draft = draftWith('racy', 4000, 5);

    await Promise.all([
      store.save(draft),
      store.save({ ...draft, status: 'complete' }),
      store.saveInProgress(draft),
      store.clearInProgress(),
      store.saveInProgress(draft),
      store.save(draft),
    ]);

    const written = await store.load('racy');
    expect(written?.draftId).toBe('racy');
    expect(written?.picks).toHaveLength(5);

    // No temp files left behind.
    const names = await readdir(store.dir);
    expect(names.filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps the previous version when a write fails midway', async () => {
    const draft = draftWith('stable', 6000, 2);
    await store.save(draft);

    // A value JSON.stringify can't serialize stands in for a crash mid-write.
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    await expect(
      store.save({ ...draft, picks: circular as never }),
    ).rejects.toThrow();

    expect(await store.load('stable')).toEqual(draft);
    const names = await readdir(store.dir);
    expect(names.filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('does not let a draft id escape the drafts directory', async () => {
    await store.save(draftWith('../../evil', 1000));
    const names = await readdir(store.dir);
    expect(names).toEqual(['.._.._evil.json']);
  });
});

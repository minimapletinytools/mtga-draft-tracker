import type { CardInfo, Draft, DraftSummary, DraftTrackerBridge } from '@drafttracker/core';
import { emptyDraft, summarizeDraft } from '@drafttracker/core';
import fixture from './fixture.json';

interface Fixture {
  drafts: Draft[];
  cards: Record<string, CardInfo>;
}

const DATA = fixture as unknown as Fixture;

/**
 * A bridge backed by a bundled sample draft, installed when the page is opened
 * without the Electron preload script.
 *
 * It implements the same interface the real bridge does, so the UI has no
 * idea it isn't talking to Arena — which is the point: the whole interface can
 * be developed and reviewed in a browser tab.
 */
export function installDevBridge(): void {
  const cards = new Map<number, CardInfo>();
  for (const [id, card] of Object.entries(DATA.cards)) cards.set(Number(id), card);

  const drafts = new Map<string, Draft>(DATA.drafts.map((draft) => [draft.draftId, draft]));

  // Replay the first draft one pick at a time, so the live view has something
  // to animate through rather than appearing fully formed.
  const replaySource = DATA.drafts[0];
  const liveListeners = new Set<(state: never) => void>();
  const cardListeners = new Set<(state: never) => void>();
  const changedListeners = new Set<() => void>();

  let replayIndex = replaySource === undefined ? 0 : replaySource.picks.length;
  let liveDraft: Draft | null = null;

  function currentState(): never {
    const status =
      liveDraft === null ? 'waiting' : liveDraft.status === 'in-progress' ? 'drafting' : 'complete';
    return {
      status,
      draft: liveDraft,
      pickCount: liveDraft?.picks.length ?? 0,
      message: 'Dev bridge: replaying the bundled sample draft.',
    } as never;
  }

  function emitLive(): void {
    const state = currentState();
    for (const listener of liveListeners) listener(state);
  }

  function step(): void {
    if (replaySource === undefined) return;

    if (replayIndex >= replaySource.picks.length) {
      liveDraft = replaySource;
      replayIndex = replaySource.picks.length;
      emitLive();
      return;
    }

    replayIndex += 1;
    liveDraft = {
      ...replaySource,
      status: replayIndex >= replaySource.picks.length ? replaySource.status : 'in-progress',
      deck: replayIndex >= replaySource.picks.length ? replaySource.deck : null,
      picks: replaySource.picks.slice(0, replayIndex),
    };
    emitLive();
  }

  const bridge: DraftTrackerBridge = {
    onLive(callback) {
      liveListeners.add(callback as (state: never) => void);
      // Deliver the current state, like the real bridge does on window load.
      queueMicrotask(() => callback(currentState() as never));
      return () => liveListeners.delete(callback as (state: never) => void);
    },
    onCardDb(callback) {
      cardListeners.add(callback as (state: never) => void);
      callback({
        phase: 'ready',
        receivedBytes: 0,
        totalBytes: null,
        cardCount: cards.size,
        source: 'scryfall',
        message: null,
      });
      return () => cardListeners.delete(callback as (state: never) => void);
    },
    onDraftsChanged(callback) {
      changedListeners.add(callback);
      return () => changedListeners.delete(callback);
    },
    getCards: (grpIds) => {
      const out: Record<number, CardInfo> = {};
      for (const grpId of grpIds) {
        const card = cards.get(grpId);
        if (card !== undefined) out[grpId] = card;
      }
      return Promise.resolve(out);
    },
    listDrafts: () =>
      Promise.resolve(
        [...drafts.values()]
          .map(summarizeDraft)
          .sort((a, b) => b.startedAt - a.startedAt)
          .map((summary: DraftSummary) => summary),
      ),
    getDraft: (draftId) => Promise.resolve(drafts.get(draftId) ?? null),
    deleteDraft: (draftId) => {
      drafts.delete(draftId);
      for (const listener of changedListeners) listener();
      return Promise.resolve();
    },
    revealDraft: () => Promise.resolve(),
    refreshCardData: () =>
      Promise.resolve({
        phase: 'ready' as const,
        receivedBytes: 0,
        totalBytes: null,
        cardCount: cards.size,
        source: 'scryfall' as const,
        message: null,
      }),
    getPaths: () =>
      Promise.resolve({ logPath: null, draftsDir: '(dev fixture)', cacheDir: '(dev fixture)' }),
  };

  window.drafttracker = bridge;

  // Play the sample draft out over a few seconds so the live view behaves like
  // the real thing: packs arriving one at a time.
  liveDraft = emptyDraft(replaySource?.draftId ?? 'dev', Date.now());
  liveDraft.eventName = replaySource?.eventName ?? null;
  liveDraft.setCode = replaySource?.setCode ?? null;
  replayIndex = 0;

  // `?instant` skips the replay, which is what screenshot tooling wants.
  const instant =
    typeof location !== 'undefined' && new URLSearchParams(location.search).has('instant');

  if (instant) {
    liveDraft = replaySource ?? liveDraft;
    replayIndex = replaySource?.picks.length ?? 0;
    emitLive();
    return;
  }

  emitLive();

  let timer: ReturnType<typeof setInterval> | null = setInterval(() => {
    step();
    if (replayIndex >= (replaySource?.picks.length ?? 0) && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }, 700);
}

export { DATA as devFixture };

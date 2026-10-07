import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sortPicks, type Draft, type LiveState } from '@drafttracker/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { DraftTracker, type DraftTrackerOptions } from '../src/draftTracker.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/draft-session.log', import.meta.url));
const FIXTURE_TEXT = readFileSync(FIXTURE, 'utf8');

interface Harness {
  tracker: DraftTracker;
  live: LiveState[];
  finished: Draft[];
  decks: Draft[];
}

/**
 * A tracker wired for deterministic tests: synchronous emission (so there is
 * nothing to await) and a log path that is never read because the fixture is
 * fed in directly.
 */
function makeTracker(overrides: Partial<DraftTrackerOptions> = {}): Harness {
  const live: LiveState[] = [];
  const finished: Draft[] = [];
  const decks: Draft[] = [];

  const tracker = new DraftTracker({
    logPath: '/nonexistent/Player.log',
    onLive: (state) => live.push(state),
    onDraftFinished: (draft) => finished.push(draft),
    onDeckCaptured: (draft) => decks.push(draft),
    setForCard: () => 'FRA',
    emitScheduler: (flush) => flush(),
    ...overrides,
  });

  return { tracker, live, finished, decks };
}

/** A make-pick line, built the way Arena writes them. */
function makePickLine(draftId: string, pack: number, pick: number, grpIds: number[]): string {
  const request = JSON.stringify({ DraftId: draftId, GrpIds: grpIds, Pack: pack, Pick: pick });
  return `[UnityCrossThreadLogger]==> EventPlayerDraftMakePick ${JSON.stringify({
    id: 'req',
    request,
  })}`;
}

describe('DraftTracker', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeTracker();
    h.tracker.ingestText(FIXTURE_TEXT);
  });

  it('captures every pick of the draft', () => {
    const draft = h.tracker.snapshot();
    expect(draft?.draftId).toBe('cb5c1e21-07d7-4bbf-9183-765664909bb3');
    expect(draft?.picks).toHaveLength(42);

    // 3 packs of 14, in order, with nothing missing.
    expect(draft?.picks.map((p) => `${p.pack}.${p.pick}`)).toEqual(
      [1, 2, 3].flatMap((pack) => Array.from({ length: 14 }, (_, i) => `${pack}.${i + 1}`)),
    );
  });

  it('records which cards were seen and which was taken', () => {
    const draft = h.tracker.snapshot() as Draft;
    const first = draft.picks[0];

    expect(first?.pack).toBe(1);
    expect(first?.pick).toBe(1);
    expect(first?.cardsSeen).toHaveLength(14);
    expect(first?.cardsSeen).toContain(106333);
    expect(first?.picked).toBe(106333);

    // The last pick of a pack is down to a single card.
    const last = draft.picks[41];
    expect(last?.pack).toBe(3);
    expect(last?.pick).toBe(14);
    expect(last?.cardsSeen).toEqual([106255]);
    expect(last?.picked).toBe(106255);

    // The pack must shrink by exactly one card per pick.
    for (const pack of [1, 2, 3]) {
      const sizes = sortPicks(draft.picks.filter((p) => p.pack === pack)).map(
        (p) => p.cardsSeen.length,
      );
      expect(sizes).toEqual([14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    }
  });

  it('stamps picks with the timestamps Arena printed, not the parse time', () => {
    const draft = h.tracker.snapshot() as Draft;
    const first = draft.picks[0];
    const last = draft.picks[41];

    expect(first?.seenAt).toBe(new Date(2026, 9, 6, 17, 41, 37, 0).getTime());
    expect(last?.pickedAt).not.toBeNull();
    expect(last?.pickedAt as number).toBeGreaterThan(first?.seenAt as number);
  });

  it('labels the draft with its event and set', () => {
    const draft = h.tracker.snapshot();
    expect(draft?.eventName).toBe('PremierDraft_FRA_20260929');
    expect(draft?.setCode).toBe('FRA');
  });

  it('prefers the set read off the cards over the event name', () => {
    const other = makeTracker({ setForCard: () => 'OTJ' });
    other.tracker.ingestText(FIXTURE_TEXT);
    // The event name says FRA, but every card in the pack is from OTJ.
    expect(other.tracker.snapshot()?.setCode).toBe('OTJ');
  });

  it('marks the draft complete and hands it over for saving', () => {
    expect(h.tracker.snapshot()?.status).toBe('complete');
    expect(h.finished).toHaveLength(1);
    expect(h.finished[0]?.draftId).toBe('cb5c1e21-07d7-4bbf-9183-765664909bb3');
  });

  it('attaches the submitted deck', () => {
    const deck = h.tracker.snapshot()?.deck;
    expect(deck?.deckId).toBe('d07ccce0-964e-4630-beb0-82d0ea29c550');
    expect(deck?.mainDeck.reduce((n, e) => n + e.quantity, 0)).toBe(40);
    expect(h.decks).toHaveLength(1);
  });

  it('ends in the complete live state with a usable snapshot', () => {
    const state = h.live.at(-1);
    expect(state?.status).toBe('complete');
    expect(state?.pickCount).toBe(42);
    expect(state?.draft?.picks).toHaveLength(42);
  });

  it('is idempotent when the log is replayed from the start', () => {
    h.tracker.ingestText(FIXTURE_TEXT);
    const draft = h.tracker.snapshot();
    expect(draft?.picks).toHaveLength(42);
    expect(draft?.deck?.mainDeck.reduce((n, e) => n + e.quantity, 0)).toBe(40);
  });

  it('never mutates a snapshot the caller already holds', () => {
    const before = h.tracker.snapshot() as Draft;
    expect(before.picks[0]?.cardsSeen).toHaveLength(14);

    h.tracker.ingestLine(
      '[UnityCrossThreadLogger]Draft.Notify {"draftId":"cb5c1e21-07d7-4bbf-9183-765664909bb3","SelfPick":1,"SelfPack":1,"PackCards":"1,2"}',
    );
    expect(before.picks[0]?.cardsSeen).toHaveLength(14);
  });
});

describe('DraftTracker session boundaries', () => {
  it('keeps the pack while a pick is still pending — the live-preview state', () => {
    const h = makeTracker();
    h.tracker.ingestLine(
      '[UnityCrossThreadLogger]Draft.Notify {"draftId":"d1","SelfPick":2,"SelfPack":1,"PackCards":"10,20,30"}',
    );

    const draft = h.tracker.snapshot();
    expect(draft?.status).toBe('in-progress');
    expect(draft?.picks).toHaveLength(1);
    expect(draft?.picks[0]?.cardsSeen).toEqual([10, 20, 30]);
    expect(draft?.picks[0]?.picked).toBeNull();
    expect(h.live.at(-1)?.status).toBe('drafting');
  });

  it('fills in the pick when the make-pick line follows the pack', () => {
    const h = makeTracker();
    h.tracker.ingestLine(
      '[UnityCrossThreadLogger]Draft.Notify {"draftId":"d1","SelfPick":2,"SelfPack":1,"PackCards":"10,20,30"}',
    );
    h.tracker.ingestLine(makePickLine('d1', 1, 2, [20]));

    const pick = h.tracker.snapshot()?.picks[0];
    expect(pick?.cardsSeen).toEqual([10, 20, 30]);
    expect(pick?.picked).toBe(20);
  });

  it('recovers a pick whose pack was never seen', () => {
    const h = makeTracker();
    h.tracker.ingestLine(makePickLine('d9', 2, 3, [77]));

    const draft = h.tracker.snapshot();
    expect(draft?.draftId).toBe('d9');
    expect(draft?.picks[0]?.picked).toBe(77);
    expect(draft?.picks[0]?.cardsSeen).toEqual([]);
  });

  it('closes out a draft that a new draftId supersedes', () => {
    const h = makeTracker();
    h.tracker.ingestLine(
      '[UnityCrossThreadLogger]Draft.Notify {"draftId":"old","SelfPick":1,"SelfPack":1,"PackCards":"1,2,3"}',
    );
    h.tracker.ingestLine(
      '[UnityCrossThreadLogger]Draft.Notify {"draftId":"new","SelfPick":1,"SelfPack":1,"PackCards":"4,5,6"}',
    );

    expect(h.finished).toHaveLength(1);
    expect(h.finished[0]?.draftId).toBe('old');
    expect(h.finished[0]?.status).toBe('abandoned');
    expect(h.tracker.snapshot()?.draftId).toBe('new');
    expect(h.tracker.snapshot()?.picks).toHaveLength(1);
  });

  it('completes on a one-card final pack even without DraftCompleteDraft', () => {
    const h = makeTracker();
    h.tracker.ingestLine(
      '[UnityCrossThreadLogger]Draft.Notify {"draftId":"d1","SelfPick":14,"SelfPack":3,"PackCards":"9"}',
    );
    h.tracker.ingestLine(makePickLine('d1', 3, 14, [9]));

    expect(h.tracker.snapshot()?.status).toBe('complete');
    expect(h.finished).toHaveLength(1);
  });

  it('takes the event name from a PlayerDraft course line', () => {
    const h = makeTracker();
    h.tracker.ingestLine(
      '{"Course":{"CourseId":"c","InternalEventName":"PremierDraft_OTJ_20260101","CurrentModule":"PlayerDraft"}}',
    );
    h.tracker.ingestLine(
      '[UnityCrossThreadLogger]Draft.Notify {"draftId":"d1","SelfPick":1,"SelfPack":1,"PackCards":"1,2,3"}',
    );

    expect(h.tracker.snapshot()?.eventName).toBe('PremierDraft_OTJ_20260101');
  });

  it('ignores a completion for a different event', () => {
    const h = makeTracker();
    h.tracker.ingestLine(
      '{"Course":{"CourseId":"c","InternalEventName":"PremierDraft_FRA_20260929","CurrentModule":"PlayerDraft"}}',
    );
    h.tracker.ingestLine(
      '[UnityCrossThreadLogger]Draft.Notify {"draftId":"d1","SelfPick":1,"SelfPack":1,"PackCards":"1,2,3"}',
    );
    h.tracker.ingestLine(
      '[UnityCrossThreadLogger]==> DraftCompleteDraft {"id":"x","request":"{\\"EventName\\":\\"PremierDraft_OTJ_20260101\\",\\"IsBotDraft\\":false}"}',
    );

    expect(h.tracker.snapshot()?.status).toBe('in-progress');
    expect(h.finished).toHaveLength(0);
  });

  it('refuses to attach a constructed deck to a draft', () => {
    const h = makeTracker();
    h.tracker.ingestLine(
      '[UnityCrossThreadLogger]Draft.Notify {"draftId":"d1","SelfPick":1,"SelfPack":1,"PackCards":"1,2,3"}',
    );
    h.tracker.ingestLine(
      '[UnityCrossThreadLogger]==> EventSetDeckV3 {"id":"x","request":"{\\"EventName\\":\\"Constructed_BestOf3\\",\\"Summary\\":{\\"DeckId\\":\\"z\\"},\\"Deck\\":{\\"MainDeck\\":[{\\"cardId\\":1,\\"quantity\\":4}]}}"}"}',
    );

    expect(h.tracker.snapshot()?.deck).toBeNull();
    expect(h.decks).toHaveLength(0);
  });

  it('adopts the event name when the draft started before we were watching', () => {
    const h = makeTracker();
    h.tracker.ingestLine(
      '[UnityCrossThreadLogger]Draft.Notify {"draftId":"d1","SelfPick":1,"SelfPack":1,"PackCards":"1,2,3"}',
    );
    expect(h.tracker.snapshot()?.eventName).toBeNull();

    h.tracker.ingestLine(
      '[UnityCrossThreadLogger]==> DraftCompleteDraft {"id":"x","request":"{\\"EventName\\":\\"QuickDraft_FRA_20260929\\",\\"IsBotDraft\\":true}"}',
    );

    const draft = h.tracker.snapshot();
    expect(draft?.eventName).toBe('QuickDraft_FRA_20260929');
    expect(draft?.setCode).toBe('FRA');
    expect(draft?.isBotDraft).toBe(true);
  });
});

describe('DraftTracker resume', () => {
  it('merges a restored draft instead of starting over', () => {
    const h = makeTracker();
    h.tracker.restore({
      draftId: 'cb5c1e21-07d7-4bbf-9183-765664909bb3',
      eventName: 'PremierDraft_FRA_20260929',
      setCode: 'FRA',
      isBotDraft: false,
      startedAt: 1,
      updatedAt: 1,
      status: 'in-progress',
      picks: [{ pack: 1, pick: 1, cardsSeen: [106333], picked: 106333, seenAt: 1, pickedAt: 2 }],
      deck: null,
    });

    expect(h.tracker.snapshot()?.picks).toHaveLength(1);
    h.tracker.ingestText(FIXTURE_TEXT);

    // The restored pick is not duplicated by the replay.
    const draft = h.tracker.snapshot() as Draft;
    expect(draft.picks).toHaveLength(42);
    expect(draft.picks[0]?.cardsSeen).toHaveLength(14);
  });
});

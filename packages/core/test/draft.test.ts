import { describe, expect, it } from 'vitest';
import {
  emptyDraft,
  findPick,
  formatPickLabel,
  humanizeEventName,
  inferSetCode,
  lastSlot,
  packSize,
  pickKey,
  pickedCards,
  poolCounts,
  referencedGrpIds,
  setCodeFromEventName,
  sortPicks,
  summarizeDraft,
  totalPicked,
  type Draft,
} from '../src/index.js';

function buildDraft(): Draft {
  const draft = emptyDraft('d1', 1000);
  draft.eventName = 'PremierDraft_FRA_20260929';
  draft.setCode = 'FRA';
  draft.status = 'complete';
  draft.picks = [
    { pack: 2, pick: 1, cardsSeen: [4, 5, 6, 7], picked: 4, seenAt: 3000, pickedAt: 3100 },
    { pack: 1, pick: 1, cardsSeen: [1, 2, 3, 4], picked: 1, seenAt: 1000, pickedAt: 1100 },
    { pack: 1, pick: 2, cardsSeen: [2, 3, 4], picked: 1, seenAt: 2000, pickedAt: 2100 },
    { pack: 3, pick: 1, cardsSeen: [9], picked: null, seenAt: 4000, pickedAt: null },
  ];
  draft.deck = {
    deckId: 'deck',
    name: 'Draft Deck',
    mainDeck: [
      { grpId: 1, quantity: 2 },
      { grpId: 4, quantity: 1 },
    ],
    sideboard: [{ grpId: 9, quantity: 1 }],
    capturedAt: 5000,
  };
  return draft;
}

describe('pick ordering helpers', () => {
  it('sorts by pack then pick regardless of insertion order', () => {
    expect(sortPicks(buildDraft().picks).map((p) => `${p.pack}.${p.pick}`)).toEqual([
      '1.1',
      '1.2',
      '2.1',
      '3.1',
    ]);
  });

  it('reports the last slot observed', () => {
    expect(lastSlot(buildDraft())).toEqual({ pack: 3, pick: 1 });
    expect(lastSlot(emptyDraft('x', 0))).toBeNull();
  });

  it('finds a pick by slot', () => {
    const draft = buildDraft();
    expect(findPick(draft, 2, 1)?.picked).toBe(4);
    expect(findPick(draft, 9, 9)).toBeNull();
  });

  it('builds a stable key', () => {
    expect(pickKey(2, 11)).toBe('2:11');
  });

  it('formats a pick label the way players read it', () => {
    expect(formatPickLabel(1, 3)).toBe('P1P3');
  });
});

describe('draft contents', () => {
  it('lists the cards taken, in pick order', () => {
    expect(pickedCards(buildDraft())).toEqual([1, 1, 4]);
  });

  it('counts copies in the pool', () => {
    expect([...poolCounts(buildDraft())]).toEqual([
      [1, 2],
      [4, 1],
    ]);
  });

  it('counts confirmed picks only', () => {
    expect(totalPicked(buildDraft())).toBe(3);
  });

  it('collects every grpId a UI would need, decks included', () => {
    const ids = referencedGrpIds(buildDraft());
    expect(new Set(ids)).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 9]));
  });
});

describe('packSize', () => {
  it('reads the pack size off a full first pack', () => {
    const draft = buildDraft();
    draft.picks = [
      { pack: 1, pick: 1, cardsSeen: [1, 2, 3, 4, 5], picked: 1, seenAt: 1, pickedAt: 2 },
      { pack: 1, pick: 2, cardsSeen: [2, 3, 4, 5], picked: 2, seenAt: 3, pickedAt: 4 },
    ];
    expect(packSize(draft)).toBe(5);
  });

  it('reconstructs the size when pick 1 was missed', () => {
    const draft = buildDraft();
    draft.picks = [
      { pack: 1, pick: 3, cardsSeen: [1, 2, 3], picked: 1, seenAt: 1, pickedAt: 2 },
    ];
    // 3 cards left at pick 3 means the pack opened with 5.
    expect(packSize(draft)).toBe(5);
  });

  it('is zero for an empty draft', () => {
    expect(packSize(emptyDraft('x', 0))).toBe(0);
  });
});

describe('setCodeFromEventName', () => {
  it('pulls the set out of Arena’s event names', () => {
    expect(setCodeFromEventName('PremierDraft_FRA_20260929')).toBe('FRA');
    expect(setCodeFromEventName('QuickDraft_OTJ_20260101')).toBe('OTJ');
    expect(setCodeFromEventName('Sealed_BLB_20260315')).toBe('BLB');
  });

  it('returns null when there is nothing to read', () => {
    expect(setCodeFromEventName(null)).toBeNull();
    expect(setCodeFromEventName('Draft')).toBeNull();
    expect(setCodeFromEventName('PremierDraft_20260929')).toBeNull();
  });
});

describe('humanizeEventName', () => {
  it('splits the camel case and drops the set and date', () => {
    expect(humanizeEventName('PremierDraft_FRA_20260929')).toBe('Premier Draft');
    expect(humanizeEventName('QuickDraft_OTJ_20260101')).toBe('Quick Draft');
  });

  it('falls back rather than showing nothing', () => {
    expect(humanizeEventName(null)).toBe('Unknown event');
    expect(humanizeEventName('TraditionalDraft')).toBe('Traditional Draft');
  });
});

describe('inferSetCode', () => {
  const lookup = (id: number): string | null => {
    if (id === 99) return 'SPG'; // a bonus-list card
    if (id === 100) return null; // unknown to the card database
    return 'FRA';
  };

  it('takes the majority set', () => {
    expect(inferSetCode([1, 2, 3, 4, 99], lookup)).toBe('FRA');
  });

  it('refuses to guess from a minority', () => {
    // Only half the cards resolve, and they disagree.
    expect(inferSetCode([99, 1], lookup)).toBeNull();
  });

  it('ignores ids the database does not know', () => {
    expect(inferSetCode([100, 100, 1, 2, 3], lookup)).toBe('FRA');
  });

  it('returns null for an empty list', () => {
    expect(inferSetCode([], lookup)).toBeNull();
  });
});

describe('summarizeDraft', () => {
  it('produces a history row without the pick payloads', () => {
    const summary = summarizeDraft(buildDraft());
    expect(summary.draftId).toBe('d1');
    expect(summary.setCode).toBe('FRA');
    expect(summary.capturedPicks).toBe(4);
    expect(summary.confirmedPicks).toBe(3);
    expect(summary.firstPick).toBe(1);
    expect(summary.mainDeckCount).toBe(3);
    expect(summary.deckTileId).toBe(1);
    expect(summary).not.toHaveProperty('picks');
  });
});

describe('emptyDraft', () => {
  it('starts in progress with nothing in it', () => {
    const draft = emptyDraft('new', 42);
    expect(draft.status).toBe('in-progress');
    expect(draft.picks).toEqual([]);
    expect(draft.deck).toBeNull();
    expect(draft.startedAt).toBe(42);
  });
});

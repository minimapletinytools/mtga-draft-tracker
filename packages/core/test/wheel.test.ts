import { describe, expect, it } from 'vitest';
import {
  detectWheelOffset,
  emptyDraft,
  findWheelSource,
  packCardIds,
  sortPicks,
  wheelInfoFor,
  type Draft,
  type DraftPick,
} from '../src/index.js';

const POD = 8;
const PACK_SIZE = 14;

/**
 * A realistic pack: eight *different* physical packs come round in picks 1-8,
 * then the first six return as picks 9-14 with eight cards gone.
 *
 * Pack `p` (0-indexed) holds cards `p*100..p*100+13`. By the time it reaches
 * this player at pick `p+1`, the `p` players before them have each taken one,
 * so it shows `14 - p` cards; eight picks later, `14 - p - 8` remain.
 *
 * The packs share no card ids, which matters: with a real set's duplicate
 * commons small packs overlap by coincidence, and surviving that is the whole
 * job of the offset detection.
 */
function realisticPack(pack: number): DraftPick[] {
  const picks: DraftPick[] = [];

  for (let p = 0; p < POD; p += 1) {
    const base = p * 100;
    const sightings: Array<{ pick: number; from: number }> = [{ pick: p + 1, from: base + p }];
    const wheelPick = p + 1 + POD;
    // By the wheel, the p players before us *and* the POD that followed have
    // each taken one.
    if (wheelPick <= PACK_SIZE) sightings.push({ pick: wheelPick, from: base + p + POD });

    for (const { pick, from } of sightings) {
      const cardsSeen: number[] = [];
      for (let card = from; card < base + PACK_SIZE; card += 1) cardsSeen.push(card);
      if (cardsSeen.length === 0) continue;

      picks.push({
        pack,
        pick,
        cardsSeen,
        picked: cardsSeen[0] ?? null,
        seenAt: pick,
        pickedAt: pick,
      });
    }
  }

  return sortPicks(picks);
}

function draftOf(picks: DraftPick[]): Draft {
  const draft = emptyDraft('d', 1);
  draft.picks = picks;
  return draft;
}

const pickAt = (picks: DraftPick[], pick: number): DraftPick =>
  picks.find((p) => p.pick === pick) as DraftPick;

describe('detectWheelOffset', () => {
  it('finds the table size from the packs alone', () => {
    expect(detectWheelOffset(realisticPack(1))).toBe(POD);
  });

  it('finds a smaller table', () => {
    // Four-player pod: the pack returns after four picks.
    const picks: DraftPick[] = [];
    for (let p = 0; p < 4; p += 1) {
      const base = p * 100;
      picks.push({
        pack: 1,
        pick: p + 1,
        cardsSeen: Array.from({ length: PACK_SIZE - p }, (_, i) => base + p + i),
        picked: base + p,
        seenAt: p,
        pickedAt: p,
      });
      const wheelPick = p + 5;
      if (wheelPick <= PACK_SIZE) {
        picks.push({
          pack: 1,
          pick: wheelPick,
          cardsSeen: Array.from({ length: PACK_SIZE - p - 4 }, (_, i) => base + p + 4 + i),
          picked: base + p + 4,
          seenAt: wheelPick,
          pickedAt: wheelPick,
        });
      }
    }
    expect(detectWheelOffset(sortPicks(picks))).toBe(4);
  });

  it('returns null when a pack never comes back', () => {
    const picks: DraftPick[] = [1, 2, 3, 4].map((pick) => ({
      pack: 1,
      pick,
      cardsSeen: Array.from({ length: PACK_SIZE + 1 - pick }, (_, i) => pick * 100 + i),
      picked: pick * 100,
      seenAt: pick,
      pickedAt: pick,
    }));
    expect(detectWheelOffset(picks)).toBeNull();
  });

  it('returns null for a pack with too little data', () => {
    expect(detectWheelOffset([])).toBeNull();
    expect(
      detectWheelOffset([
        { pack: 1, pick: 1, cardsSeen: [1, 2], picked: 1, seenAt: 1, pickedAt: 1 },
      ]),
    ).toBeNull();
  });
});

describe('findWheelSource', () => {
  const picks = realisticPack(1);

  it('does not call the fresh packs in picks 1-8 wheels', () => {
    for (let pick = 1; pick <= 8; pick += 1) {
      const index = picks.findIndex((p) => p.pick === pick);
      expect(findWheelSource(picks, index, POD)).toBeNull();
    }
  });

  it('pairs each wheel pick with the pack it came from', () => {
    for (let pick = 9; pick <= 14; pick += 1) {
      const index = picks.findIndex((p) => p.pick === pick);
      expect(findWheelSource(picks, index, POD)?.pick).toBe(pick - POD);
    }
  });

  it('ignores an offset that does not fit', () => {
    const index = picks.findIndex((p) => p.pick === 9);
    expect(findWheelSource(picks, index, 3)).toBeNull();
  });

  it('is null for an out-of-range index or offset', () => {
    expect(findWheelSource(picks, 99, POD)).toBeNull();
    expect(findWheelSource(picks, 10, 0)).toBeNull();
  });
});

describe('wheelInfoFor', () => {
  it('reports what left the pack and who took it', () => {
    const picks = realisticPack(1);
    const wheel = wheelInfoFor(draftOf(picks), pickAt(picks, 9));

    expect(wheel?.source.pick).toBe(1);
    // P1P1 opened with 14; P1P9 shows 6, so eight cards are gone.
    expect(wheel?.missing).toHaveLength(8);
    // The one this player took at P1P1 is theirs, not another player's.
    expect(wheel?.takenBySelf).toBe(pickAt(picks, 1).picked);
  });

  it('attributes the right pick on the last, smallest pack', () => {
    // The regression this guards: with one card left, several earlier picks
    // can contain it by coincidence. The detected offset has to win.
    const picks = realisticPack(1);
    const wheel = wheelInfoFor(draftOf(picks), pickAt(picks, 14));

    expect(wheel?.source.pick).toBe(6);
    expect(wheel?.missing).toHaveLength(8);
  });

  it('is null for a freshly opened pack', () => {
    const picks = realisticPack(1);
    const draft = draftOf(picks);
    for (let pick = 1; pick <= 8; pick += 1) {
      expect(wheelInfoFor(draft, pickAt(picks, pick))).toBeNull();
    }
  });

  it('keeps packs separate', () => {
    const second = realisticPack(2);
    const draft = draftOf(sortPicks([...realisticPack(1), ...second]));
    const wheel = wheelInfoFor(draft, pickAt(second, 9));
    expect(wheel?.source.pack).toBe(2);
    expect(wheel?.source.pick).toBe(1);
  });

  it('is null when the pack was never captured whole', () => {
    const only: DraftPick = {
      pack: 1,
      pick: 9,
      cardsSeen: [10, 11],
      picked: 10,
      seenAt: 1,
      pickedAt: 1,
    };
    expect(wheelInfoFor(draftOf([only]), only)).toBeNull();
  });

  it('separates the player’s own pick from other players’', () => {
    const picks = realisticPack(1);
    const wheel = wheelInfoFor(draftOf(picks), pickAt(picks, 10));

    expect(wheel?.source.pick).toBe(2);
    expect(wheel?.takenBySelf).toBe(pickAt(picks, 2).picked);
    // Seven of the eight missing cards went to other players.
    expect(wheel?.missing.filter((c) => c !== wheel.takenBySelf)).toHaveLength(7);
  });
});

describe('packCardIds', () => {
  it('returns what is in the pack for a fresh pick', () => {
    const picks = realisticPack(1);
    const draft = draftOf(picks);
    expect(packCardIds(draft, pickAt(picks, 1))).toEqual(pickAt(picks, 1).cardsSeen);
  });

  it('returns the whole source pack on a wheel, not what is left of it', () => {
    // The regression this guards: the view draws the original 14 cards, so
    // the lookup has to ask for 14 — asking for the 6 still in the pack left
    // the taken cards rendering as bare Arena ids.
    const picks = realisticPack(1);
    const draft = draftOf(picks);
    const ids = packCardIds(draft, pickAt(picks, 9));

    expect(ids).toHaveLength(14);
    expect(ids).toEqual(pickAt(picks, 1).cardsSeen);
  });

  it('covers every card the wheel view marks as gone', () => {
    const picks = realisticPack(1);
    const draft = draftOf(picks);
    const pick = pickAt(picks, 14);
    const wheel = wheelInfoFor(draft, pick);
    const ids = new Set(packCardIds(draft, pick));

    for (const gone of wheel?.missing ?? []) expect(ids.has(gone)).toBe(true);
  });

  it('is empty for no pick', () => {
    expect(packCardIds(draftOf(realisticPack(1)), undefined)).toEqual([]);
  });
});

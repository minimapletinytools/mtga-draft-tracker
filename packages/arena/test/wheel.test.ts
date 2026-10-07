import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { detectWheelOffset, sortPicks, wheelInfoFor, type Draft } from '@drafttracker/core';
import { describe, expect, it } from 'vitest';
import { DraftTracker } from '../src/draftTracker.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/draft-session.log', import.meta.url));

/** The real draft captured in the log fixture, replayed through the tracker. */
function realDraft(): Draft {
  let latest: Draft | null = null;
  const tracker = new DraftTracker({
    logPath: '/nonexistent/Player.log',
    onLive: (state) => {
      if (state.draft !== null) latest = state.draft;
    },
    emitScheduler: (flush) => flush(),
  });
  tracker.ingestText(readFileSync(FIXTURE, 'utf8'));
  if (latest === null) throw new Error('fixture produced no draft');
  return latest;
}

const draft = realDraft();

describe('wheel detection against a real Arena draft', () => {
  it('detects an eight-player table', () => {
    // Premier Draft is an eight-player pod, and the data has to say so without
    // being told: every other offset scores near zero on this log.
    for (const pack of [1, 2, 3]) {
      const inPack = sortPicks(draft.picks.filter((p) => p.pack === pack));
      expect(detectWheelOffset(inPack)).toBe(8);
    }
  });

  it('marks exactly picks 9-14 of each pack as wheels', () => {
    const wheels = sortPicks(draft.picks)
      .filter((pick) => wheelInfoFor(draft, pick) !== null)
      .map((pick) => `${pick.pack}.${pick.pick}`);

    expect(wheels).toEqual(
      [1, 2, 3].flatMap((pack) =>
        Array.from({ length: 6 }, (_, i) => `${pack}.${9 + i}`),
      ),
    );
  });

  it('pairs each wheel with the pack it opened from', () => {
    for (const pick of sortPicks(draft.picks)) {
      const wheel = wheelInfoFor(draft, pick);
      if (wheel === null) continue;
      expect(wheel.source.pick).toBe(pick.pick - 8);
      expect(wheel.source.pack).toBe(pick.pack);
    }
  });

  it('accounts for every card that left the pack', () => {
    for (const pick of sortPicks(draft.picks)) {
      const wheel = wheelInfoFor(draft, pick);
      if (wheel === null) continue;

      // Eight picks passed, so eight cards went — no more, no fewer.
      expect(wheel.missing).toHaveLength(8);
      expect(wheel.source.cardsSeen.length - pick.cardsSeen.length).toBe(8);

      // Nothing still in the pack can be reported as taken.
      const remaining = new Set(pick.cardsSeen);
      for (const gone of wheel.missing) expect(remaining.has(gone)).toBe(false);
    }
  });

  it('attributes the player’s own pick correctly rather than blaming an opponent', () => {
    const first = sortPicks(draft.picks).find((p) => p.pack === 1 && p.pick === 9);
    const wheel = wheelInfoFor(draft, first as Draft['picks'][number]);

    // We took 106333 at P1P1 out of this very pack, so it is ours.
    expect(wheel?.takenBySelf).toBe(106333);
    // The other seven went to other players.
    expect(wheel?.missing.filter((c) => c !== 106333)).toHaveLength(7);
  });

  it('reports nothing taken by the player when their own pick survived', () => {
    // P1P6's card cannot be in P1P14's wheel: it was taken out of that pack.
    const wheel = wheelInfoFor(
      draft,
      sortPicks(draft.picks).find((p) => p.pack === 1 && p.pick === 14) as Draft['picks'][number],
    );
    expect(wheel?.source.pick).toBe(6);
    expect(wheel?.takenBySelf).toBe(
      sortPicks(draft.picks).find((p) => p.pack === 1 && p.pick === 6)?.picked,
    );
  });
});

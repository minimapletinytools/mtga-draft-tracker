import { useMemo } from 'react';
import { detectWheelOffset, findWheelSource, type DraftPick } from '@drafttracker/core';

interface PickRailProps {
  picks: DraftPick[];
  packs: number[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  /** True while the newest pick is still being chosen. */
  liveAtEnd: boolean;
}

/**
 * Every pick in the draft, grouped by pack, as a vertical strip.
 *
 * This is the "go through the history" surface: clicking a cell jumps the pack
 * view to that pick, so a whole draft can be replayed one pick at a time.
 *
 * Picks whose pack has already been round the table are marked, because those
 * are the ones where the view can show what other players took.
 */
export function PickRail({ picks, packs, selectedIndex, onSelect, liveAtEnd }: PickRailProps) {
  // Which picks are wheels, resolved per pack rather than per rendered cell.
  const wheels = useMemo(() => {
    const map = new Set<string>();
    for (const pack of packs) {
      const inPack = picks.filter((pick) => pick.pack === pack);
      const offset = detectWheelOffset(inPack);
      if (offset === null) continue;
      inPack.forEach((pick, index) => {
        if (findWheelSource(inPack, index, offset) !== null) map.add(`${pick.pack}:${pick.pick}`);
      });
    }
    return map;
  }, [picks, packs]);

  return (
    <nav className="rail" aria-label="Picks">
      {packs.map((pack) => {
        const packPicks = picks
          .map((pick, index) => ({ pick, index }))
          .filter((entry) => entry.pick.pack === pack);

        const taken = packPicks.filter((entry) => entry.pick.picked !== null).length;

        return (
          <section className="rail-pack" key={pack}>
            <header className="rail-pack-header">
              <span className="rail-pack-title">Pack {pack}</span>
              <span className="rail-pack-count">
                {taken}/{packPicks.length}
              </span>
            </header>
            <ol className="rail-list">
              {packPicks.map(({ pick, index }) => {
                const selected = index === selectedIndex;
                const pending = pick.picked === null;
                const isWheel = wheels.has(`${pick.pack}:${pick.pick}`);

                const classes = ['rail-cell'];
                if (selected) classes.push('is-selected');
                if (pending) classes.push('is-pending');
                if (isWheel) classes.push('is-wheel');
                if (liveAtEnd && index === picks.length - 1) classes.push('is-live');

                return (
                  <li key={`${pick.pack}-${pick.pick}`}>
                    <button
                      type="button"
                      className={classes.join(' ')}
                      onClick={() => onSelect(index)}
                      aria-current={selected ? 'step' : undefined}
                      title={`Pack ${pick.pack}, pick ${pick.pick}${
                        isWheel ? ' — this pack has been round the table' : ''
                      }`}
                    >
                      <span className="rail-cell-pick">{pick.pick}</span>
                      {isWheel ? (
                        <span className="rail-cell-wheel" aria-hidden="true">
                          ↩
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}
    </nav>
  );
}

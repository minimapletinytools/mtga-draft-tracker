import type { DraftPick } from '@drafttracker/core';

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
 */
export function PickRail({ picks, packs, selectedIndex, onSelect, liveAtEnd }: PickRailProps) {
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
                const classes = ['rail-cell'];
                if (selected) classes.push('is-selected');
                if (pending) classes.push('is-pending');
                if (liveAtEnd && index === picks.length - 1) classes.push('is-live');

                return (
                  <li key={`${pick.pack}-${pick.pick}`}>
                    <button
                      type="button"
                      className={classes.join(' ')}
                      onClick={() => onSelect(index)}
                      aria-current={selected ? 'step' : undefined}
                      title={`Pack ${pick.pack}, pick ${pick.pick} — ${pick.cardsSeen.length} cards seen`}
                    >
                      <span className="rail-cell-pick">{pick.pick}</span>
                      <span className="rail-cell-meta">
                        {pending ? '—' : `${pick.cardsSeen.length} seen`}
                      </span>
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

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { Draft } from '@drafttracker/core';
import { useCardData } from '../useCardData';
import { packCardIds } from '@drafttracker/core';
import { draftLayout, formatTime } from '../format';
import {
  CARD_SCALE_STEP,
  DEFAULT_CARD_SCALE,
  MAX_CARD_SCALE,
  MIN_CARD_SCALE,
  loadCardScale,
  saveCardScale,
} from '../prefs';
import { PackView } from './PackView';
import { PickRail } from './PickRail';
import { PoolPanel } from './PoolPanel';

interface DraftViewProps {
  draft: Draft;
  /** True while this draft is still being picked, which enables auto-follow. */
  live: boolean;
  /** Bumped when card data is upgraded, so tiles re-resolve. */
  cardRevision: unknown;
}

/**
 * The one view that renders a draft — used both for the live draft and for a
 * saved draft being reviewed. Reviewing a finished draft and watching a live
 * one are the same activity (step through picks), so they share everything
 * except the "live" affordances.
 */
export function DraftView({ draft, live, cardRevision }: DraftViewProps) {
  const { picks, packs } = useMemo(() => draftLayout(draft), [draft]);

  // Which pick the user is looking at. Null means "follow the newest pick".
  const [pinnedIndex, setPinnedIndex] = useState<number | null>(null);

  // Card size is a display preference, so it survives switching drafts.
  const [cardScale, setCardScale] = useState(loadCardScale);
  useEffect(() => {
    saveCardScale(cardScale);
  }, [cardScale]);

  // A draft can gain picks while it is open; follow the end unless pinned.
  const lastIndex = picks.length - 1;
  const following = pinnedIndex === null || pinnedIndex >= lastIndex;
  const selectedIndex = following ? lastIndex : Math.max(0, Math.min(pinnedIndex, lastIndex));

  // A different draft is a different timeline — start it at the end.
  useEffect(() => {
    setPinnedIndex(null);
  }, [draft.draftId]);

  const select = useCallback(
    (index: number) => {
      setPinnedIndex(index >= lastIndex ? null : Math.max(0, index));
    },
    [lastIndex],
  );

  const step = useCallback(
    (delta: number) => {
      const next = Math.max(0, Math.min(lastIndex, selectedIndex + delta));
      select(next);
    },
    [lastIndex, selectedIndex, select],
  );

  const stepPack = useCallback(
    (delta: number) => {
      const current = picks[selectedIndex];
      if (current === undefined) return;
      const targetPack = current.pack + delta;
      const target = picks.find((pick) => pick.pack === targetPack);
      if (target === undefined) return;
      const index = picks.indexOf(target);
      select(index);
    },
    [picks, selectedIndex, select],
  );

  // Keyboard navigation, the fastest way through 42 picks.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target !== null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      switch (event.key) {
        case 'ArrowLeft':
          step(-1);
          break;
        case 'ArrowRight':
          step(1);
          break;
        case 'ArrowUp':
          stepPack(-1);
          break;
        case 'ArrowDown':
          stepPack(1);
          break;
        case 'End':
          setPinnedIndex(null);
          break;
        default:
          return;
      }
      event.preventDefault();
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, stepPack]);

  // Resolve exactly the cards on screen, plus the pool up to this point.
  const wantedIds = useMemo(() => {
    const ids: number[] = [];
    // On a wheel this is the source pack, so those cards get fetched too.
    ids.push(...packCardIds(draft, picks[selectedIndex]));
    for (let i = 0; i <= selectedIndex; i += 1) {
      const taken = picks[i]?.picked;
      if (taken !== null && taken !== undefined) ids.push(taken);
    }
    for (const entry of draft.deck?.mainDeck ?? []) ids.push(entry.grpId);
    for (const entry of draft.deck?.sideboard ?? []) ids.push(entry.grpId);
    return ids;
  }, [picks, selectedIndex, draft]);

  const cards = useCardData(wantedIds, cardRevision);

  const selected = picks[selectedIndex];
  const taken = picks.filter((pick) => pick.picked !== null).length;

  // Drives the grid track sizes from CSS; 100% is the size the layout was
  // designed at, so nothing moves until the slider does.
  const scaleStyle = { '--card-scale': String(cardScale / 100) } as CSSProperties;

  return (
    <div className="draft-view" style={scaleStyle}>
      <PickRail
        picks={picks}
        packs={packs}
        selectedIndex={selectedIndex}
        onSelect={select}
        liveAtEnd={live}
      />

      <main className="draft-main">
        <div className="draft-toolbar">
          <div className="draft-nav">
            <button
              type="button"
              className="btn btn-icon"
              onClick={() => step(-1)}
              disabled={selectedIndex <= 0}
              title="Previous pick (←)"
            >
              ←
            </button>
            <button
              type="button"
              className="btn btn-icon"
              onClick={() => step(1)}
              disabled={selectedIndex >= lastIndex}
              title="Next pick (→)"
            >
              →
            </button>
            <button
              type="button"
              className="btn btn-icon"
              onClick={() => stepPack(-1)}
              title="Previous pack (↑)"
            >
              ↑
            </button>
            <button
              type="button"
              className="btn btn-icon"
              onClick={() => stepPack(1)}
              title="Next pack (↓)"
            >
              ↓
            </button>
          </div>

          <CardSizeSlider value={cardScale} onChange={setCardScale} />

          <div className="draft-progress">
            <span className="draft-progress-label">
              {taken} of {picks.length} picks
            </span>
            <div className="progress-track">
              <div
                className="progress-fill"
                style={{ width: `${picks.length === 0 ? 0 : (taken / picks.length) * 100}%` }}
              />
            </div>
          </div>

          {!following && live ? (
            <button type="button" className="btn btn-accent" onClick={() => setPinnedIndex(null)}>
              Jump to latest
            </button>
          ) : null}

          {selected?.seenAt != null ? (
            <span className="draft-timestamp" title="Arena’s timestamp for this pack">
              {formatTime(selected.seenAt)}
            </span>
          ) : null}
        </div>

        <div className="draft-scroll">
          <PackView draft={draft} pick={selected} cards={cards} />
        </div>
      </main>

      <PoolPanel picks={picks} cards={cards} upToIndex={selectedIndex} deck={draft.deck} />
    </div>
  );
}

/**
 * Card size for the pack and pool grids.
 *
 * 100% is the size the layout was designed at; the readout doubles as a reset
 * so getting back to it never needs a careful drag.
 */
function CardSizeSlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (next: number) => void;
}) {
  const isDefault = value === DEFAULT_CARD_SCALE;

  return (
    <label className="card-size" title="Card size in the pack and pool">
      <span className="card-size-label">Card size</span>
      <input
        type="range"
        min={MIN_CARD_SCALE}
        max={MAX_CARD_SCALE}
        step={CARD_SCALE_STEP}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label="Card size"
      />
      <button
        type="button"
        className={isDefault ? 'card-size-value' : 'card-size-value is-changed'}
        onClick={() => onChange(DEFAULT_CARD_SCALE)}
        disabled={isDefault}
        title={isDefault ? 'Card size' : 'Reset to 100%'}
      >
        {value}%
      </button>
    </label>
  );
}

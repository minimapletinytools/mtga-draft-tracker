import type { CardInfo } from '@drafttracker/core';
import { ManaCost, RarityGem } from './ManaCost';

export type TileSize = 'pack' | 'pool' | 'rail';

interface CardTileProps {
  grpId: number;
  card: CardInfo | undefined;
  size?: TileSize;
  /** Draws the ring and badge used for the card that was actually taken. */
  picked?: boolean;
  /** Draws a "not yet picked" marker on the pack's still-open pick. */
  pending?: boolean;
  /** Greys the card out — used for cards that have left the pack. */
  dimmed?: boolean;
  /** A short factual label in the corner, e.g. who took a missing card. */
  cornerNote?: string | null;
  /** Copies owned, shown on pool tiles. */
  count?: number;
  onClick?: () => void;
  title?: string;
}

/**
 * One card.
 *
 * Card art is a bonus, not a requirement: a freshly released set has names in
 * Arena's database but no Scryfall art for days, and the browser may simply be
 * offline. So every tile falls back to a typographic card — name, cost, type —
 * that is readable on its own.
 */
export function CardTile({
  grpId,
  card,
  size = 'pack',
  picked = false,
  pending = false,
  dimmed = false,
  cornerNote = null,
  count,
  onClick,
  title,
}: CardTileProps) {
  const classes = ['tile', `tile-${size}`];
  if (picked) classes.push('is-picked');
  if (pending) classes.push('is-pending');
  if (dimmed) classes.push('is-dimmed');
  if (card === undefined) classes.push('is-unknown');

  const label = card?.name ?? `Card ${grpId}`;
  const interactive = onClick !== undefined;
  const hasArt = card?.imageSmall != null;

  return (
    <button
      type="button"
      className={classes.join(' ')}
      onClick={onClick}
      disabled={!interactive}
      title={title ?? label}
      aria-label={picked ? `${label} (picked)` : label}
    >
      <span className="tile-art">
        {hasArt ? (
          <img src={card.imageSmall as string} alt="" loading="lazy" draggable={false} />
        ) : (
          <span className="tile-placeholder">
            <span className="tile-placeholder-name">{label}</span>
            {card !== undefined && card.typeLine.length > 0 ? (
              <span className="tile-placeholder-type">{card.typeLine}</span>
            ) : null}
          </span>
        )}
      </span>

      {/*
        A card with art gets its name underneath; a card without already shows
        it inside the frame, and repeating it there just looks like a bug.
      */}
      {size !== 'rail' && hasArt ? (
        <span className="tile-caption">
          <span className="tile-name">{label}</span>
          {card !== undefined && card.manaCost.length > 0 ? (
            <ManaCost cost={card.manaCost} className="mana-cost-small" />
          ) : null}
        </span>
      ) : null}

      {count !== undefined && count > 1 ? <span className="tile-count">×{count}</span> : null}
      {cornerNote !== null ? <span className="tile-corner-note">{cornerNote}</span> : null}
      {picked ? <span className="tile-badge">Picked</span> : null}
      {pending ? <span className="tile-badge tile-badge-pending">Choosing…</span> : null}
      {card !== undefined && size === 'pack' ? (
        <span className="tile-rarity">
          <RarityGem rarity={card.rarity} />
        </span>
      ) : null}
    </button>
  );
}

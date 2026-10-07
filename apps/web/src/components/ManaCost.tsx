import type { CardInfo } from '@drafttracker/core';
import { manaPips, pipClass } from '../format';

/** Renders "{2}{W}{W}" as mana pips. */
export function ManaCost({ cost, className }: { cost: string; className?: string }) {
  const pips = manaPips(cost);
  if (pips.length === 0) return null;

  return (
    <span className={className === undefined ? 'mana-cost' : `mana-cost ${className}`}>
      {pips.map((symbol, index) => (
        <i key={`${symbol}-${index}`} className={pipClass(symbol)}>
          {symbol}
        </i>
      ))}
    </span>
  );
}

export function RarityGem({ rarity }: { rarity: CardInfo['rarity'] }) {
  return <i className={`rarity rarity-${rarity}`} title={rarity} aria-label={rarity} />;
}

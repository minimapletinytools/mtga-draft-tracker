import { useMemo } from 'react';
import type { CardInfo, DraftDeck, DraftPick } from '@drafttracker/core';
import type { CardMap } from '../useCardData';
import { CardTile } from './CardTile';
import { GROUP_LABELS, groupOrder, isLand, pluralize, poolGroupOf, type PoolGroup } from '../format';

interface PoolPanelProps {
  picks: DraftPick[];
  cards: CardMap;
  /** Restricts the pool to picks at or before this index. */
  upToIndex: number;
  /** The submitted deck, when there is one. */
  deck: DraftDeck | null;
}

interface PoolStack {
  grpId: number;
  count: number;
}

/**
 * The right-hand panel: what the player had at the selected point in the
 * draft, grouped by colour the way a pool gets laid out on a table.
 *
 * Showing the pool *as of the selected pick* rather than the final pool is
 * what makes reviewing a draft useful — stepping forward one pick at a time
 * shows exactly when a colour came together.
 */
export function PoolPanel({ picks, cards, upToIndex, deck }: PoolPanelProps) {
  const stacks = useMemo(() => {
    const counts = new Map<number, number>();
    for (let i = 0; i <= upToIndex && i < picks.length; i += 1) {
      const grpId = picks[i]?.picked;
      if (grpId === null || grpId === undefined) continue;
      counts.set(grpId, (counts.get(grpId) ?? 0) + 1);
    }
    return [...counts.entries()].map(([grpId, count]) => ({ grpId, count }));
  }, [picks, upToIndex]);

  const groups = useMemo(() => {
    const byGroup = new Map<PoolGroup, PoolStack[]>();
    for (const stack of stacks) {
      const group = poolGroupOf(cards.get(stack.grpId));
      const list = byGroup.get(group) ?? [];
      list.push(stack);
      byGroup.set(group, list);
    }
    // Within a group, cheapest first — the order you'd scan a real pool in.
    for (const list of byGroup.values()) {
      list.sort((a, b) => {
        const cardA = cards.get(a.grpId);
        const cardB = cards.get(b.grpId);
        const landA = isLand(cardA) ? 1 : 0;
        const landB = isLand(cardB) ? 1 : 0;
        if (landA !== landB) return landA - landB;
        return (cardA?.cmc ?? 0) - (cardB?.cmc ?? 0) || (cardA?.name ?? '').localeCompare(cardB?.name ?? '');
      });
    }
    return groupOrder()
      .map((group) => ({ group, stacks: byGroup.get(group) ?? [] }))
      .filter((entry) => entry.stacks.length > 0);
  }, [stacks, cards]);

  const total = stacks.reduce((n, stack) => n + stack.count, 0);

  return (
    <aside className="pool" aria-label="Cards picked">
      <header className="pool-header">
        <h2>Pool at this pick</h2>
        <span className="pool-count">
          {pluralize(total, 'card')}
        </span>
      </header>

      {groups.length === 0 ? (
        <p className="pool-empty">No cards picked yet.</p>
      ) : (
        <div className="pool-groups">
          {groups.map(({ group, stacks: groupStacks }) => (
            <section className="pool-group" key={group}>
              <h3 className={`pool-group-title group-${group}`}>{GROUP_LABELS[group]}</h3>
              <div className="pool-grid">
                {groupStacks.map((stack) => (
                  <CardTile
                    key={stack.grpId}
                    grpId={stack.grpId}
                    card={cards.get(stack.grpId)}
                    size="pool"
                    count={stack.count}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {deck !== null ? <DeckSummary deck={deck} cards={cards} /> : null}
    </aside>
  );
}

/** The submitted 40, shown under the pool once a draft is finished. */
function DeckSummary({ deck, cards }: { deck: DraftDeck; cards: CardMap }) {
  const mainCount = deck.mainDeck.reduce((n, entry) => n + entry.quantity, 0);

  const spellGroups = useMemo(() => {
    const byGroup = new Map<PoolGroup, Map<number, number>>();
    for (const entry of deck.mainDeck) {
      const card: CardInfo | undefined = cards.get(entry.grpId);
      const group = poolGroupOf(card);
      const inner = byGroup.get(group) ?? new Map<number, number>();
      inner.set(entry.grpId, entry.quantity);
      byGroup.set(group, inner);
    }
    return groupOrder()
      .map((group) => ({ group, entries: [...(byGroup.get(group) ?? new Map()).entries()] }))
      .filter((entry) => entry.entries.length > 0);
  }, [deck, cards]);

  return (
    <section className="deck" aria-label="Submitted deck">
      <header className="pool-header deck-header">
        <h2>Submitted deck</h2>
        <span className="pool-count">{pluralize(mainCount, 'card')}</span>
      </header>

      {spellGroups.map(({ group, entries }) => (
        <div className="pool-group" key={group}>
          <h3 className={`pool-group-title group-${group}`}>{GROUP_LABELS[group]}</h3>
          <div className="pool-grid">
            {entries.map(([grpId, quantity]) => (
              <CardTile
                key={grpId}
                grpId={grpId}
                card={cards.get(grpId)}
                size="pool"
                count={quantity}
              />
            ))}
          </div>
        </div>
      ))}

      {deck.sideboard.length > 0 ? (
        <p className="deck-sideboard">
          Sideboard: {deck.sideboard.reduce((n, e) => n + e.quantity, 0)} cards
        </p>
      ) : null}
    </section>
  );
}

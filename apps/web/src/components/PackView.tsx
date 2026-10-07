import { useMemo } from 'react';
import type { DraftPick } from '@drafttracker/core';
import { packCardIds, wheelInfoFor, type Draft, type WheelInfo } from '@drafttracker/core';
import type { CardMap } from '../useCardData';
import { CardTile } from './CardTile';
import { ManaCost } from './ManaCost';
import { pluralize, rarityRank } from '../format';

interface PackViewProps {
  draft: Draft;
  pick: DraftPick | undefined;
  cards: CardMap;
}

/**
 * The pack as it was offered on one pick.
 *
 * On a wheel pick (the pack you opened, back around after eight others have
 * taken a card each) the view shows the pack as you *first* saw it, with the
 * cards that are gone greyed out. That is the only moment in a draft where you
 * can see what the other players at the table took.
 */
export function PackView({ draft, pick, cards }: PackViewProps) {
  const wheel = useMemo(
    () => (pick === undefined ? null : wheelInfoFor(draft, pick)),
    [draft, pick],
  );

  const takenInPack = useMemo(() => {
    if (wheel === null) return new Map<number, number>();
    // Which of the missing cards were taken by this player, and at which pick.
    const map = new Map<number, number>();
    if (wheel.takenBySelf !== null) map.set(wheel.takenBySelf, wheel.source.pick);
    return map;
  }, [wheel]);

  if (pick === undefined) {
    return (
      <div className="pack-empty">
        <p>No pick selected.</p>
      </div>
    );
  }

  if (pick.cardsSeen.length === 0) {
    return (
      <div className="pack-empty">
        <h2>Pack contents not captured</h2>
        <p>
          This pick was recorded before Draft Tracker started watching the log, so only the card
          that was taken is known.
        </p>
        {pick.picked !== null && cards.get(pick.picked) !== undefined ? (
          <div className="pack-empty-card">
            <CardTile grpId={pick.picked} card={cards.get(pick.picked)} size="pack" picked />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="pack">
      <PackHeader pick={pick} wheel={wheel} cards={cards} />
      {wheel !== null ? (
        <WheelGrid draft={draft} pick={pick} wheel={wheel} cards={cards} takenInPack={takenInPack} />
      ) : (
        <FreshGrid pick={pick} cards={cards} />
      )}
    </div>
  );
}

function PackHeader({
  pick,
  wheel,
  cards,
}: {
  pick: DraftPick;
  wheel: WheelInfo | null;
  cards: CardMap;
}) {
  const pickedCard = pick.picked === null ? undefined : cards.get(pick.picked);

  return (
    <div className="pack-header">
      <div>
        <h2>
          Pack {pick.pack}, pick {pick.pick}
          {wheel !== null ? <span className="wheel-tag">Wheel</span> : null}
        </h2>
        <p className="pack-sub">
          {wheel === null ? (
            <>
              {pluralize(pick.cardsSeen.length, 'card')} seen
              {pick.picked === null ? ' — pick not made yet' : ''}
            </>
          ) : (
            <>
              Back around from pick {wheel.source.pick} — {pluralize(pick.cardsSeen.length, 'card')}{' '}
              left of the {wheel.source.cardsSeen.length} you opened,{' '}
              {pluralize(wheel.missing.length, 'card')} gone
            </>
          )}
        </p>
      </div>

      {pickedCard !== undefined ? (
        <div className="pack-taken">
          <span className="pack-taken-label">Taken</span>
          <span className="pack-taken-name">{pickedCard.name}</span>
          {pickedCard.manaCost.length > 0 ? <ManaCost cost={pickedCard.manaCost} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/** A freshly opened pack: nothing is known to be missing, so just show it. */
function FreshGrid({ pick, cards }: { pick: DraftPick; cards: CardMap }) {
  // Rarest first, which is how a pack is worth scanning; Arena's own order is
  // kept within a rarity because the sort is stable.
  const ordered = useMemo(() => {
    const indexed = pick.cardsSeen.map((grpId, index) => ({ grpId, index }));
    indexed.sort((a, b) => {
      const byRarity = rarityRank(cards.get(a.grpId)) - rarityRank(cards.get(b.grpId));
      return byRarity !== 0 ? byRarity : a.index - b.index;
    });
    return indexed;
  }, [pick, cards]);

  const missing = pick.cardsSeen.filter((id) => cards.get(id) === undefined).length;

  return (
    <>
      <div className="pack-grid">
        {ordered.map(({ grpId, index }) => (
          <CardTile
            key={`${grpId}-${index}`}
            grpId={grpId}
            card={cards.get(grpId)}
            size="pack"
            picked={pick.picked === grpId}
            pending={pick.picked === null}
          />
        ))}
      </div>
      {missing > 0 ? (
        <p className="pack-note">
          {pluralize(missing, 'card')} could not be resolved to a name yet.
        </p>
      ) : null}
    </>
  );
}

/**
 * A wheel pick: the original pack, with everything that has since been taken
 * greyed out. The card this player took themselves is called out separately,
 * because "taken by another player" is the interesting part.
 */
function WheelGrid({
  draft,
  pick,
  wheel,
  cards,
  takenInPack,
}: {
  draft: Draft;
  pick: DraftPick;
  wheel: WheelInfo;
  cards: CardMap;
  takenInPack: Map<number, number>;
}) {
  const gone = useMemo(() => new Set(wheel.missing), [wheel]);

  const ordered = useMemo(() => {
    // Same helper the caller uses to decide which cards to fetch.
    const indexed = packCardIds(draft, pick).map((grpId, index) => ({ grpId, index }));
    indexed.sort((a, b) => {
      // Cards still in the pack first, then by rarity within each group, so
      // what you can actually take stays at the top.
      const goneA = gone.has(a.grpId) ? 1 : 0;
      const goneB = gone.has(b.grpId) ? 1 : 0;
      if (goneA !== goneB) return goneA - goneB;
      const byRarity = rarityRank(cards.get(a.grpId)) - rarityRank(cards.get(b.grpId));
      return byRarity !== 0 ? byRarity : a.index - b.index;
    });
    return indexed;
  }, [draft, pick, gone, cards]);

  const takenByOthers = wheel.missing.length - (wheel.takenBySelf === null ? 0 : 1);

  return (
    <>
      <div className="pack-grid">
        {ordered.map(({ grpId, index }) => {
          const isGone = gone.has(grpId);
          const selfPick = takenInPack.get(grpId);
          return (
            <CardTile
              key={`${grpId}-${index}`}
              grpId={grpId}
              card={cards.get(grpId)}
              size="pack"
              dimmed={isGone}
              // The card still here that this player is about to take.
              picked={!isGone && wheel.source.picked === grpId}
              cornerNote={
                isGone
                  ? selfPick === undefined
                    ? 'Taken'
                    : `You · P${wheel.source.pack}P${selfPick}`
                  : null
              }
            />
          );
        })}
      </div>

      <p className="pack-note pack-note-wheel">
        Greyed cards left this pack between pick {wheel.source.pick} and now —{' '}
        {pluralize(takenByOthers, 'card')} taken by other players
        {wheel.takenBySelf === null
          ? ''
          : `, 1 by you at P${wheel.source.pack}P${wheel.source.pick}`}
        .
      </p>
    </>
  );
}

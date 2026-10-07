import { useMemo } from 'react';
import type { DraftPick } from '@drafttracker/core';
import type { CardMap } from '../useCardData';
import { CardTile } from './CardTile';
import { ManaCost } from './ManaCost';
import { pluralize } from '../format';

interface PackViewProps {
  pick: DraftPick | undefined;
  cards: CardMap;
}

/**
 * The pack as it was offered on one pick.
 *
 * The order Arena sent is preserved rather than sorted: it is the order the
 * client displayed, and re-sorting it would make a remembered pick harder to
 * find. The card that was taken is ringed and badged.
 */
export function PackView({ pick, cards }: PackViewProps) {
  const pickedCard = useMemo(() => {
    if (pick?.picked === null || pick === undefined) return undefined;
    return cards.get(pick.picked);
  }, [pick, cards]);

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
        {pickedCard !== undefined ? (
          <div className="pack-empty-card">
            <CardTile grpId={pick.picked as number} card={pickedCard} size="pack" picked />
          </div>
        ) : null}
      </div>
    );
  }

  const missing = pick.cardsSeen.filter((id) => cards.get(id) === undefined).length;

  return (
    <div className="pack">
      <div className="pack-header">
        <div>
          <h2>
            Pack {pick.pack}, pick {pick.pick}
          </h2>
          <p className="pack-sub">
            {pluralize(pick.cardsSeen.length, 'card')} seen
            {pick.picked === null ? ' — pick not made yet' : ''}
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

      <div className="pack-grid">
        {pick.cardsSeen.map((grpId, index) => (
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
    </div>
  );
}

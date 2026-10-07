import { useMemo, type ReactElement } from 'react';
import type { CardInfo, DraftSummary, TrackerStatus } from '@drafttracker/core';
import { formatDate } from '../format';

interface HistoryListProps {
  summaries: DraftSummary[];
  cards: ReadonlyMap<number, CardInfo>;
  onOpen: (draftId: string) => void;
  onDelete: (draftId: string) => void;
  onReveal: (draftId: string) => void;
  /** The draft being tracked right now, if any — shown pinned above the rest. */
  liveDraftId: string | null;
  status: TrackerStatus;
}

function statusLabel(status: DraftSummary['status']): string {
  switch (status) {
    case 'complete':
      return 'Completed';
    case 'in-progress':
      return 'Unfinished';
    case 'abandoned':
      return 'Abandoned';
  }
}

/** Every draft this app has saved, newest first. */
export function HistoryList({
  summaries,
  cards,
  onOpen,
  onDelete,
  onReveal,
  liveDraftId,
  status,
}: HistoryListProps) {
  const { live, saved } = useMemo(() => {
    const live: DraftSummary[] = [];
    const saved: DraftSummary[] = [];
    for (const summary of summaries) {
      if (summary.draftId === liveDraftId) live.push(summary);
      else saved.push(summary);
    }
    return { live, saved };
  }, [summaries, liveDraftId]);

  if (summaries.length === 0) {
    return (
      <div className="empty-state">
        <h2>No drafts saved yet</h2>
        <p>
          {status === 'no-log'
            ? 'Draft Tracker could not find Arena’s log file.'
            : 'Start a draft in MTG Arena. Every pick shows up here in real time, and the draft is saved automatically when it ends.'}
        </p>
      </div>
    );
  }

  const renderRow = (summary: DraftSummary, isLive: boolean): ReactElement => {
    const tile = summary.deckTileId ?? summary.firstPick;
    const card = tile === null ? undefined : cards.get(tile);
    const classes = ['history-row'];
    if (isLive) classes.push('is-live');

    return (
      <li key={summary.draftId} className={classes.join(' ')}>
        <button type="button" className="history-open" onClick={() => onOpen(summary.draftId)}>
          <span className="history-thumb">
            {card?.imageSmall != null ? (
              <img src={card.imageSmall} alt="" loading="lazy" />
            ) : (
              <span className="history-thumb-blank" />
            )}
          </span>

          <span className="history-body">
            <span className="history-title">
              {summary.setCode ?? 'Unknown set'}
              <span className="history-set">
                {card?.setName !== undefined && card.setName.length > 0 ? card.setName : ''}
              </span>
            </span>
            <span className="history-meta">
              <span>{formatDate(summary.startedAt)}</span>
              <span>{summary.confirmedPicks} picks</span>
              {summary.mainDeckCount > 0 ? <span>{summary.mainDeckCount}-card deck</span> : null}
              <span className={`history-status status-${summary.status}`}>
                {statusLabel(summary.status)}
              </span>
              {isLive ? <span className="history-status status-live">Current</span> : null}
            </span>
          </span>
        </button>

        <span className="history-actions">
          <button type="button" className="btn btn-quiet" onClick={() => onReveal(summary.draftId)}>
            Show file
          </button>
          <button type="button" className="btn btn-quiet btn-danger" onClick={() => onDelete(summary.draftId)}>
            Delete
          </button>
        </span>
      </li>
    );
  };

  return (
    <div className="history">
      <header className="history-header">
        <h2>Draft history</h2>
        <span className="history-count">
          {summaries.length} saved {summaries.length === 1 ? 'draft' : 'drafts'}
        </span>
      </header>

      <ul className="history-list">
        {live.map((summary) => renderRow(summary, true))}
        {saved.map((summary) => renderRow(summary, false))}
      </ul>
    </div>
  );
}

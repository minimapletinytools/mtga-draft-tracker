import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CardDbState, Draft, DraftSummary, LiveState } from '@drafttracker/core';
import { getBridge, isEmbedded } from './bridge';
import { useCardData } from './useCardData';
import { draftTitle, formatDate } from './format';
import { DraftView } from './components/DraftView';
import { HistoryList } from './components/HistoryList';
import { StatusHeader } from './components/StatusHeader';

type View = { kind: 'live' } | { kind: 'history' } | { kind: 'draft'; draftId: string };

const INITIAL_LIVE: LiveState = { status: 'waiting', draft: null, pickCount: 0, message: null };
const INITIAL_CARD_DB: CardDbState = {
  phase: 'idle',
  receivedBytes: 0,
  totalBytes: null,
  cardCount: 0,
  source: null,
  message: null,
};

export function App() {
  const bridge = getBridge();

  const [live, setLive] = useState<LiveState>(INITIAL_LIVE);
  const [cardDb, setCardDb] = useState<CardDbState>(INITIAL_CARD_DB);
  const [view, setView] = useState<View>({ kind: 'live' });
  const [summaries, setSummaries] = useState<DraftSummary[]>([]);
  const [openDraft, setOpenDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  // -------------------------------------------------------------- live wiring
  useEffect(() => {
    if (bridge === undefined) return;
    const offLive = bridge.onLive(setLive);
    const offCardDb = bridge.onCardDb(setCardDb);
    return () => {
      offLive();
      offCardDb();
    };
  }, [bridge]);

  const refreshHistory = useCallback(() => {
    if (bridge === undefined) return;
    bridge
      .listDrafts()
      .then(setSummaries)
      .catch((err: unknown) => setError(String(err)));
  }, [bridge]);

  useEffect(() => {
    refreshHistory();
    if (bridge === undefined) return;
    return bridge.onDraftsChanged(refreshHistory);
  }, [bridge, refreshHistory]);

  // ------------------------------------------------------------ opened draft
  useEffect(() => {
    if (bridge === undefined || view.kind !== 'draft') {
      setOpenDraft(null);
      return;
    }
    let cancelled = false;
    bridge
      .getDraft(view.draftId)
      .then((draft) => {
        if (!cancelled) setOpenDraft(draft);
      })
      .catch((err: unknown) => setError(String(err)));
    return () => {
      cancelled = true;
    };
  }, [bridge, view]);

  const handleDelete = useCallback(
    (draftId: string) => {
      if (bridge === undefined) return;
      void bridge.deleteDraft(draftId).then(() => {
        setSummaries((current) => current.filter((summary) => summary.draftId !== draftId));
        setView((current) =>
          current.kind === 'draft' && current.draftId === draftId ? { kind: 'history' } : current,
        );
      });
    },
    [bridge],
  );

  const handleReveal = useCallback(
    (draftId: string) => {
      void bridge?.revealDraft(draftId);
    },
    [bridge],
  );

  const handleRefreshCards = useCallback(() => {
    void bridge?.refreshCardData();
  }, [bridge]);

  // The history thumbnails need a card each; ask for them in one batch.
  const historyThumbIds = useMemo(
    () =>
      summaries
        .map((summary) => summary.deckTileId ?? summary.firstPick)
        .filter((id): id is number => id !== null),
    [summaries],
  );
  const historyCards = useCardData(historyThumbIds, cardDb.phase);

  // --------------------------------------------------------------- what's on
  const liveDraft = live.draft;
  const showingLiveDraft = view.kind === 'live' && liveDraft !== null;
  const showingSavedDraft = view.kind === 'draft' && openDraft !== null;

  const canShowHistory = summaries.length > 0;

  return (
    <div className="app">
      <StatusHeader
        live={live}
        cardDb={cardDb}
        view={view.kind === 'history' ? 'history' : view.kind === 'draft' ? 'draft' : 'live'}
        onNavigate={(next) => setView(next === 'live' ? { kind: 'live' } : { kind: 'history' })}
        historyCount={summaries.length}
        onRefreshCards={handleRefreshCards}
      />

      {error !== null ? (
        <div className="banner banner-error">
          <span>{error}</span>
          <button type="button" className="btn btn-quiet" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      {!isEmbedded() ? (
        <div className="banner banner-dev">
          <span>
            Running in a browser without the desktop bridge — showing the bundled sample draft.
          </span>
        </div>
      ) : null}

      <div className="app-body">
        {showingLiveDraft ? (
          <DraftView
            draft={liveDraft as Draft}
            live={live.status === 'drafting'}
            cardRevision={cardDb.phase}
          />
        ) : showingSavedDraft ? (
          <div className="saved-draft">
            <div className="saved-draft-bar">
              <button type="button" className="btn" onClick={() => setView({ kind: 'history' })}>
                ← History
              </button>
              <h1 className="saved-draft-title">{draftTitle(openDraft as Draft)}</h1>
              <span className="saved-draft-date">
                {formatDate((openDraft as Draft).startedAt)}
              </span>
            </div>
            <DraftView draft={openDraft as Draft} live={false} cardRevision={cardDb.phase} />
          </div>
        ) : view.kind === 'history' || canShowHistory ? (
          <HistoryList
            summaries={summaries}
            cards={historyCards}
            onOpen={(draftId) => setView({ kind: 'draft', draftId })}
            onDelete={handleDelete}
            onReveal={handleReveal}
            liveDraftId={liveDraft?.draftId ?? null}
            status={live.status}
          />
        ) : (
          <WaitingState live={live} onShowHistory={canShowHistory ? () => setView({ kind: 'history' }) : null} />
        )}
      </div>
    </div>
  );
}

/** The empty state the app spends most of its life in. */
function WaitingState({ live, onShowHistory }: { live: LiveState; onShowHistory: (() => void) | null }) {
  const isWarning = live.status === 'no-log' || live.status === 'parse-error';

  return (
    <div className="empty-state">
      <h2>{isWarning ? 'Waiting for MTG Arena' : 'Waiting for a draft'}</h2>
      <p>
        {live.message ??
          'Draft Tracker watches Arena’s log file. Open a draft and every pack will appear here as you see it.'}
      </p>
      {onShowHistory !== null ? (
        <button type="button" className="btn" onClick={onShowHistory}>
          Browse saved drafts
        </button>
      ) : null}
    </div>
  );
}

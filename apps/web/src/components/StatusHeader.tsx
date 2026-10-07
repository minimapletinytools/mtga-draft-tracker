import type { CardDbState, LiveState } from '@drafttracker/core';

interface StatusHeaderProps {
  live: LiveState;
  cardDb: CardDbState;
  view: 'live' | 'history' | 'draft';
  onNavigate: (view: 'live' | 'history') => void;
  historyCount: number;
  onRefreshCards: () => void;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

/** The card-data situation, phrased as "what can the app show me right now". */
function CardDataStatus({ state, onRefresh }: { state: CardDbState; onRefresh: () => void }) {
  const downloading = state.phase === 'downloading' || state.phase === 'parsing';

  if (downloading) {
    const percent =
      state.totalBytes !== null && state.totalBytes > 0
        ? Math.min(100, (state.receivedBytes / state.totalBytes) * 100)
        : null;

    return (
      <div className="carddb carddb-busy">
        <span className="carddb-label">
          {state.phase === 'parsing' ? 'Indexing card art' : 'Downloading card art'}
          {percent === null ? ` — ${megabytes(state.receivedBytes)}` : ` — ${percent.toFixed(0)}%`}
        </span>
        <div className="progress-track progress-track-thin">
          <div
            className="progress-fill"
            style={{ width: percent === null ? '100%' : `${percent}%` }}
          />
        </div>
      </div>
    );
  }

  if (state.phase === 'error') {
    return (
      <div className="carddb carddb-error" title={state.message ?? undefined}>
        <span className="carddb-label">Card art unavailable</span>
        <button type="button" className="btn btn-quiet" onClick={onRefresh}>
          Retry
        </button>
      </div>
    );
  }

  if (state.phase === 'ready') {
    return (
      <div className="carddb carddb-ready">
        <span className="carddb-label">
          {state.cardCount.toLocaleString()} cards{state.source === 'scryfall' ? ' · art loaded' : ''}
        </span>
      </div>
    );
  }

  return (
    <div className="carddb">
      <span className="carddb-label">
        {state.source === 'arena' ? `${state.cardCount.toLocaleString()} cards from MTG Arena` : 'Loading cards…'}
      </span>
    </div>
  );
}

function TrackerPill({ live }: { live: LiveState }) {
  const { status, draft, pickCount } = live;

  if (status === 'drafting' && draft !== null) {
    const picks = draft.picks;
    const latest = picks[picks.length - 1];
    return (
      <span className="pill pill-live">
        <span className="pill-dot" />
        Drafting
        {latest !== undefined ? ` · Pack ${latest.pack} Pick ${latest.pick}` : ''}
        <span className="pill-sub">{pickCount} picks</span>
      </span>
    );
  }

  if (status === 'complete') {
    return (
      <span className="pill pill-done">
        Draft complete
        <span className="pill-sub">saved to history</span>
      </span>
    );
  }

  if (status === 'no-log' || status === 'parse-error') {
    return (
      <span className="pill pill-warn" title={live.message ?? undefined}>
        {status === 'no-log' ? 'Arena log not found' : 'Log error'}
      </span>
    );
  }

  return (
    <span className="pill pill-idle">
      <span className="pill-dot" />
      Waiting for a draft
    </span>
  );
}

export function StatusHeader({
  live,
  cardDb,
  view,
  onNavigate,
  historyCount,
  onRefreshCards,
}: StatusHeaderProps) {
  return (
    <header className="app-header">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">Draft Tracker</span>
      </div>

      <nav className="tabs">
        <button
          type="button"
          className={view === 'live' ? 'tab is-active' : 'tab'}
          onClick={() => onNavigate('live')}
        >
          Live draft
        </button>
        <button
          type="button"
          className={view === 'history' ? 'tab is-active' : 'tab'}
          onClick={() => onNavigate('history')}
        >
          History
          {historyCount > 0 ? <span className="tab-badge">{historyCount}</span> : null}
        </button>
      </nav>

      <div className="header-right">
        <CardDataStatus state={cardDb} onRefresh={onRefreshCards} />
        <TrackerPill live={live} />
      </div>
    </header>
  );
}

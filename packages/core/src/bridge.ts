import type { CardDbState, CardInfo, Draft, DraftSummary, LiveState } from './types.js';

/**
 * The contract between the Electron main process and the web UI, exposed on
 * `window.drafttracker`. Pinned — main, preload and renderer all import this
 * so the three can't drift apart silently.
 *
 * Everything is push-based for live state and request/response for anything
 * the UI asks for on demand. Card data is fetched by id in batches rather than
 * shipped wholesale: the full database is ~35,000 cards.
 */
export interface DraftTrackerBridge {
  /** Current draft state; also replays the latest value on window load. */
  onLive(callback: (state: LiveState) => void): () => void;

  /** Progress of the one-time Scryfall download. */
  onCardDb(callback: (state: CardDbState) => void): () => void;

  /** Fires when a draft is saved or deleted, so the history list can refresh. */
  onDraftsChanged(callback: () => void): () => void;

  /** Card facts for exactly the ids asked for; unknown ids are omitted. */
  getCards(grpIds: number[]): Promise<Record<number, CardInfo>>;

  /** Saved drafts, newest first. */
  listDrafts(): Promise<DraftSummary[]>;

  /** A full saved draft, including every pick and the submitted deck. */
  getDraft(draftId: string): Promise<Draft | null>;

  deleteDraft(draftId: string): Promise<void>;

  /** Opens the draft's JSON file in Finder/Explorer. */
  revealDraft(draftId: string): Promise<void>;

  /** Re-downloads the Scryfall bulk data, ignoring the cache. */
  refreshCardData(): Promise<CardDbState>;

  getPaths(): Promise<AppPaths>;
}

export interface AppPaths {
  /** Where Arena writes Player.log on this machine. */
  logPath: string | null;
  /** Where this app saves finished drafts. */
  draftsDir: string;
  /** Where the Scryfall cache lives. */
  cacheDir: string;
}

declare global {
  interface Window {
    drafttracker?: DraftTrackerBridge;
  }
}

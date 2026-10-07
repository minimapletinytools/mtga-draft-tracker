/** The five MTG colors. */
export type Color = 'W' | 'U' | 'B' | 'R' | 'G';

/** Colour plus colourless — used for mana the card database can report. */
export type ManaColor = Color | 'C';

/** Rarity letters as Scryfall spells them. */
export type Rarity = 'common' | 'uncommon' | 'rare' | 'mythic' | 'special' | 'bonus';

/**
 * Where a card's facts came from.
 *
 * `arena` means MTGA's own local card database, which is always current but
 * has no art or mana cost; `scryfall` means the bulk download, which has both
 * but lags a set release by days. The UI leans on this to decide between an
 * art tile and a text tile.
 */
export type CardSource = 'arena' | 'scryfall';

/**
 * The card facts we keep for a draft. Deliberately small: the Scryfall bulk
 * download is cached as one JSON file, so every field here is multiplied by
 * ~35,000 cards.
 */
export interface CardInfo {
  /** Arena grpId (Scryfall's `arena_id`). */
  id: number;
  name: string;
  set: string;
  /** Uppercase set code, e.g. "FRA". */
  setName: string;
  collectorNumber: string;
  /** Scryfall mana cost like "{1}{R}"; empty when only Arena data is known. */
  manaCost: string;
  /** Converted mana cost; 0 when only Arena data is known. */
  cmc: number;
  colors: Color[];
  typeLine: string;
  rarity: Rarity;
  /** Null until Scryfall data arrives for this card. */
  imageSmall: string | null;
  imageNormal: string | null;
  source: CardSource;
}

/** A `number[]` of Arena grpIds, in the order Arena presented them. */
export type GrpIds = number[];

/**
 * One pick in a draft: the pack that was offered and the card taken from it.
 *
 * `cardsSeen` comes from `Draft.Notify`; `picked` comes from the subsequent
 * `EventPlayerDraftMakePick`. Both arrive as separate log lines, so a pick can
 * legitimately exist with `picked === null` for a moment (the UI shows the
 * pack while you decide) — a state the app relies on for its preview.
 */
export interface DraftPick {
  pack: number;
  pick: number;
  cardsSeen: GrpIds;
  picked: number | null;
  /** Epoch ms the pack was first seen, or null when unknown. */
  seenAt: number | null;
  /** Epoch ms the pick was confirmed, or null when still pending. */
  pickedAt: number | null;
}

export interface DeckEntry {
  grpId: number;
  quantity: number;
}

/** The submitted 40-card deck, captured from `EventSetDeckV3`. */
export interface DraftDeck {
  deckId: string | null;
  name: string | null;
  mainDeck: DeckEntry[];
  sideboard: DeckEntry[];
  capturedAt: number;
}

export type DraftStatus = 'in-progress' | 'complete' | 'abandoned';

/** A whole draft: every pick, plus the deck once it has been submitted. */
export interface Draft {
  draftId: string;
  /** Arena's internal event name, e.g. "PremierDraft_FRA_20260929". */
  eventName: string | null;
  /** Set code, e.g. "FRA". Derived from the card database when possible. */
  setCode: string | null;
  /** True for Quick Draft / bot drafts. Null until Arena tells us. */
  isBotDraft: boolean | null;
  startedAt: number;
  updatedAt: number;
  status: DraftStatus;
  picks: DraftPick[];
  deck: DraftDeck | null;
}

/** Lightweight row for the history list — no pick payloads. */
export interface DraftSummary {
  draftId: string;
  eventName: string | null;
  setCode: string | null;
  status: DraftStatus;
  startedAt: number;
  updatedAt: number;
  isBotDraft: boolean | null;
  /** How many (pack, pick) slots we captured. */
  capturedPicks: number;
  /** How many of those have a confirmed card. */
  confirmedPicks: number;
  /** The first card taken, for a glanceable thumbnail. */
  firstPick: number | null;
  /** The deck's splashiest card, used as the history thumbnail. */
  deckTileId: number | null;
  mainDeckCount: number;
  setNames: string[];
}

/**
 * Live tracking state pushed to the UI on every change.
 *
 * `status` is intentionally separate from any single draft: the app spends
 * most of its life in `waiting`, and the UI uses that to explain itself
 * rather than looking broken.
 */
export type TrackerStatus =
  | 'waiting'
  | 'drafting'
  | 'complete'
  | 'no-log'
  | 'parse-error';

export interface LiveState {
  status: TrackerStatus;
  /** The draft currently being drafted, or the last one that finished. */
  draft: Draft | null;
  /** Picks captured so far in `draft`. */
  pickCount: number;
  /** Human-readable detail for non-happy statuses (missing log, parse error). */
  message: string | null;
}

/** Progress of the one-time Scryfall bulk download. */
export type CardDbPhase =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'parsing'
  | 'ready'
  | 'error';

export interface CardDbState {
  phase: CardDbPhase;
  /** Bytes received so far, when known. */
  receivedBytes: number;
  /** Total bytes when the server advertised a Content-Length. */
  totalBytes: number | null;
  /** How many cards the app can currently name. */
  cardCount: number;
  /** Where the loaded cards came from, or null when none are loaded yet. */
  source: CardSource | null;
  message: string | null;
}

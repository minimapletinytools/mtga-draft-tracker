import type { DeckEntry } from '@drafttracker/core';

/**
 * Everything the draft tracker cares about, distilled out of Player.log.
 *
 * Arena writes each of these as its own single line, but they arrive in
 * separate lines rather than one payload, so the tracker correlates them by
 * draftId + (pack, pick) rather than expecting a single document.
 */
export type DraftLogEvent =
  | {
      kind: 'pack';
      draftId: string;
      pack: number;
      pick: number;
      /** The cards in the pack at this pick — the "cards seen". */
      cards: number[];
      at: number | null;
    }
  | {
      kind: 'make-pick';
      draftId: string;
      pack: number;
      pick: number;
      grpIds: number[];
      at: number | null;
    }
  | {
      kind: 'draft-start';
      eventName: string | null;
      at: number | null;
    }
  | {
      kind: 'draft-complete';
      eventName: string | null;
      isBotDraft: boolean | null;
      at: number | null;
    }
  | {
      kind: 'deck';
      eventName: string | null;
      deckId: string | null;
      name: string | null;
      mainDeck: DeckEntry[];
      sideboard: DeckEntry[];
      at: number | null;
    };

export interface TailerCallbacks {
  /** New text appended to the log since the last poll. */
  onChunk(text: string): void;
  /** The log shrank or was replaced (Arena truncates it on launch). */
  onTruncate(): void;
  /** The log file is missing or unreadable. */
  onError(err: Error): void;
}

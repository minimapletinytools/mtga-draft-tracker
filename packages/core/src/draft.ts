import type { Draft, DraftPick, DraftSummary, GrpIds } from './types.js';

/** Packs in a normal Arena draft. */
export const DRAFT_PACKS = 3;

/** Stable key for a (pack, pick) slot. */
export function pickKey(pack: number, pick: number): string {
  return `${pack}:${pick}`;
}

/** "P1P3" — the label every MTG player already reads fluently. */
export function formatPickLabel(pack: number, pick: number): string {
  return `P${pack}P${pick}`;
}

/** Sorts in-place-safe order: pack ascending, then pick ascending. */
export function sortPicks(picks: DraftPick[]): DraftPick[] {
  return [...picks].sort((a, b) => (a.pack - b.pack) || (a.pick - b.pick));
}

/** Every card the player actually took, in pick order. */
export function pickedCards(draft: Draft): GrpIds {
  const out: GrpIds = [];
  for (const p of sortPicks(draft.picks)) {
    if (p.picked !== null) out.push(p.picked);
  }
  return out;
}

/**
 * grpId → copies taken. Picks only, so this is the card *pool* rather than
 * the finished deck.
 */
export function poolCounts(draft: Draft): Map<number, number> {
  const counts = new Map<number, number>();
  for (const p of sortPicks(draft.picks)) {
    if (p.picked === null) continue;
    counts.set(p.picked, (counts.get(p.picked) ?? 0) + 1);
  }
  return counts;
}

/** All distinct grpIds a draft mentions — the ids a UI needs card data for. */
export function referencedGrpIds(draft: Draft): number[] {
  const ids = new Set<number>();
  for (const p of draft.picks) {
    for (const id of p.cardsSeen) ids.add(id);
    if (p.picked !== null) ids.add(p.picked);
  }
  for (const entry of draft.deck?.mainDeck ?? []) ids.add(entry.grpId);
  for (const entry of draft.deck?.sideboard ?? []) ids.add(entry.grpId);
  return [...ids];
}

/**
 * The total number of cards the first pack of this draft held, which is the
 * number of picks in a full pack. Arena packs are usually 14 cards (Play
 * Boosters) but older sets and cubes differ, so read it off the data rather
 * than hard-coding.
 */
export function packSize(draft: Draft): number {
  let best = 0;
  for (const p of draft.picks) {
    if (p.pack !== 1) continue;
    // Pick 1 is the only pick whose pack is still full.
    if (p.pick === 1) return p.cardsSeen.length;
    best = Math.max(best, p.cardsSeen.length + (p.pick - 1));
  }
  return best;
}

/** The last (pack, pick) slot observed, used to bound the navigation UI. */
export function lastSlot(draft: Draft): { pack: number; pick: number } | null {
  let last: { pack: number; pick: number } | null = null;
  for (const p of draft.picks) {
    if (last === null || p.pack > last.pack || (p.pack === last.pack && p.pick > last.pick)) {
      last = { pack: p.pack, pick: p.pick };
    }
  }
  return last;
}

export function findPick(draft: Draft, pack: number, pick: number): DraftPick | null {
  return draft.picks.find((p) => p.pack === pack && p.pick === pick) ?? null;
}

/**
 * "PremierDraft_FRA_20260929" → "FRA". Arena packs the set code between the
 * event kind and a trailing date; anything that doesn't match yields null and
 * the caller falls back to reading the set off the cards themselves.
 */
export function setCodeFromEventName(eventName: string | null): string | null {
  if (!eventName) return null;
  const parts = eventName.split('_').filter((part) => part.length > 0);
  for (const part of parts) {
    // A bare date, e.g. 20260929.
    if (/^\d{8}$/.test(part)) continue;
    // A set code is 3-6 alphanumerics and is not the event-kind word.
    if (/^[A-Za-z0-9]{2,6}$/.test(part) && !/draft|sealed|event|game/i.test(part)) {
      return part.toUpperCase();
    }
  }
  return null;
}

/** "PremierDraft_FRA_20260929" → "Premier Draft". Falls back to the raw name. */
export function humanizeEventName(eventName: string | null): string {
  if (!eventName) return 'Unknown event';
  const first = eventName.split('_')[0] ?? eventName;
  const spaced = first
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  return spaced.length > 0 ? spaced : eventName;
}

/**
 * Guesses a draft's set from its cards, which beats parsing the event name:
 * the event name is absent if the app joined mid-draft, and it can lag a
 * remaster or a chaos draft.
 *
 * Requires a strict majority, because a pack legitimately contains a
 * bonus-list card (or a basic land) from another set, and a tie would
 * otherwise be decided by whichever set happened to be seen first.
 */
export function inferSetCode(
  grpIds: Iterable<number>,
  setForCard: (grpId: number) => string | null,
): string | null {
  const tally = new Map<string, number>();
  let total = 0;

  for (const grpId of grpIds) {
    total += 1;
    const set = setForCard(grpId);
    if (set === null) continue;
    tally.set(set, (tally.get(set) ?? 0) + 1);
  }

  let best: string | null = null;
  let bestCount = 0;
  for (const [set, count] of tally) {
    if (count > bestCount) {
      best = set;
      bestCount = count;
    }
  }

  // A strict majority, not a plurality: on a tie the first set seen would win
  // arbitrarily, and a two-card pack really can hold one bonus-list card.
  if (best === null || bestCount * 2 <= total) return null;
  return best;
}

export function totalPicked(draft: Draft): number {
  return draft.picks.reduce((n, p) => (p.picked !== null ? n + 1 : n), 0);
}

export function summarizeDraft(draft: Draft): DraftSummary {
  const ordered = sortPicks(draft.picks);
  const firstPick = ordered.find((p) => p.picked !== null)?.picked ?? null;

  let mainDeckCount = 0;
  for (const entry of draft.deck?.mainDeck ?? []) mainDeckCount += entry.quantity;

  return {
    draftId: draft.draftId,
    eventName: draft.eventName,
    setCode: draft.setCode,
    status: draft.status,
    startedAt: draft.startedAt,
    updatedAt: draft.updatedAt,
    isBotDraft: draft.isBotDraft,
    capturedPicks: draft.picks.length,
    confirmedPicks: totalPicked(draft),
    firstPick,
    deckTileId: draft.deck?.mainDeck[0]?.grpId ?? null,
    mainDeckCount,
    // Filled in by the caller once card data is available.
    setNames: [],
  };
}

/** Empty draft shell for a draftId we have just learned about. */
export function emptyDraft(draftId: string, now: number): Draft {
  return {
    draftId,
    eventName: null,
    setCode: null,
    isBotDraft: null,
    startedAt: now,
    updatedAt: now,
    status: 'in-progress',
    picks: [],
    deck: null,
  };
}

import type { CardInfo, Color, Draft } from '@drafttracker/core';
import { humanizeEventName, packSize, sortPicks } from '@drafttracker/core';

/** Card frames, in WUBRG order — the order players read a pool in. */
export const COLOR_ORDER: Color[] = ['W', 'U', 'B', 'R', 'G'];

/**
 * A pool grouping key. Multicolour cards get their own bucket, and colourless
 * cards (artifacts, lands) sort last — which is how a draft pool is normally
 * laid out on a table.
 */
export type PoolGroup = 'W' | 'U' | 'B' | 'R' | 'G' | 'multicolor' | 'colorless';

const GROUP_ORDER: PoolGroup[] = ['W', 'U', 'B', 'R', 'G', 'multicolor', 'colorless'];

export const GROUP_LABELS: Record<PoolGroup, string> = {
  W: 'White',
  U: 'Blue',
  B: 'Black',
  R: 'Red',
  G: 'Green',
  multicolor: 'Multicolour',
  colorless: 'Colorless & Lands',
};

export function groupOrder(): PoolGroup[] {
  return GROUP_ORDER;
}

export function poolGroupOf(card: CardInfo | undefined): PoolGroup {
  const colors = card?.colors ?? [];
  if (colors.length === 0) return 'colorless';
  if (colors.length > 1) return 'multicolor';
  return (colors[0] ?? 'colorless') as PoolGroup;
}

export function isLand(card: CardInfo | undefined): boolean {
  return card?.typeLine.toLowerCase().includes('land') ?? false;
}

export function isBasicLand(card: CardInfo | undefined): boolean {
  return card?.typeLine.toLowerCase().includes('basic land') ?? false;
}

/** Rarest first — the order a pack is worth scanning in. */
const RARITY_RANK: Record<CardInfo['rarity'], number> = {
  mythic: 0,
  rare: 1,
  bonus: 2,
  special: 3,
  uncommon: 4,
  common: 5,
};

/**
 * Sort key for a pack. Basic lands sink below everything (they are the pack's
 * land slot, never a pick), and unresolved cards sit with the commons rather
 * than jumping the queue.
 */
export function rarityRank(card: CardInfo | undefined): number {
  if (card === undefined) return RARITY_RANK.common;
  if (isBasicLand(card)) return 99;
  return RARITY_RANK[card.rarity] ?? RARITY_RANK.common;
}

/** Splits a Scryfall mana cost into renderable pips: "{2}{W}{W}" → ["2","W","W"]. */
export function manaPips(manaCost: string): string[] {
  const pips: string[] = [];
  const re = /\{([^}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(manaCost)) !== null) {
    const symbol = match[1];
    if (symbol !== undefined && symbol.length > 0) pips.push(symbol);
  }
  return pips;
}

/** The CSS class for a mana symbol, e.g. "W" → "pip pip-w", "2" → "pip pip-generic". */
export function pipClass(symbol: string): string {
  const upper = symbol.toUpperCase();
  if (COLOR_ORDER.includes(upper as Color)) return `pip pip-${upper.toLowerCase()}`;
  if (upper === 'C') return 'pip pip-c';
  if (/^\d+$/.test(upper)) return 'pip pip-generic';
  if (upper === 'X' || upper === 'Y' || upper === 'Z') return 'pip pip-x';
  // Hybrid and Phyrexian symbols keep a readable single letter.
  const letters = upper.replace(/[^WUBRGCP]/g, '');
  return `pip pip-hybrid pip-${(letters[0] ?? 'c').toLowerCase()}`;
}

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function formatDate(epochMs: number | null): string {
  if (epochMs === null || !Number.isFinite(epochMs)) return '—';
  return DATE_FORMAT.format(new Date(epochMs));
}

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
});

export function formatTime(epochMs: number | null): string {
  if (epochMs === null || !Number.isFinite(epochMs)) return '—';
  return TIME_FORMAT.format(new Date(epochMs));
}

/** "Premier Draft · FRA" — what a draft is called in the UI. */
export function draftTitle(draft: Draft): string {
  const event = humanizeEventName(draft.eventName);
  return draft.setCode === null ? event : `${event} · ${draft.setCode}`;
}

/**
 * The picks in navigation order, plus the derived facts the UI needs to render
 * a pack: how big the packs were, and where the pack boundaries are.
 */
export function draftLayout(draft: Draft): {
  picks: Draft['picks'];
  packs: number[];
  size: number;
} {
  const picks = sortPicks(draft.picks);
  const packs = [...new Set(picks.map((p) => p.pack))].sort((a, b) => a - b);
  return { picks, packs, size: packSize(draft) };
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

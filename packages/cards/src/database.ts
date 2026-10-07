import type { CardInfo, Color, Rarity } from '@drafttracker/core';

/** Bumped whenever the tuple layout changes, invalidating old caches. */
export const CACHE_VERSION = 2;

/**
 * A card on disk, as a positional tuple.
 *
 * The full default-cards set is ~35,000 Arena-legal printings, so repeating
 * JSON key names ("manaCost", "imageNormal", …) costs more than the data does.
 * Tuples keep the cache around 8 MB instead of ~20 MB.
 */
export type CompactCard = [
  name: string,
  setName: string,
  setCode: string,
  collectorNumber: string,
  manaCost: string,
  cmc: number,
  /** Colors as concatenated letters, e.g. "WU". Empty for colorless. */
  colorLetters: string,
  typeLine: string,
  rarity: string,
  imageSmall: string,
  imageNormal: string,
];

export interface CacheFileShape {
  version: number;
  /** Scryfall's `updated_at` for the bulk file this cache came from. */
  updatedAt: string;
  cards: Record<string, CompactCard>;
}

const COLORS = new Set<string>(['W', 'U', 'B', 'R', 'G']);
const RARITIES = new Set<string>(['common', 'uncommon', 'rare', 'mythic', 'special', 'bonus']);

function decodeColors(letters: string): Color[] {
  const out: Color[] = [];
  for (const letter of letters) {
    if (COLORS.has(letter)) out.push(letter as Color);
  }
  return out;
}

function decodeRarity(raw: string): Rarity {
  return (RARITIES.has(raw) ? raw : 'common') as Rarity;
}

export function decodeCompactCard(grpId: number, tuple: CompactCard): CardInfo {
  return {
    id: grpId,
    name: tuple[0],
    setName: tuple[1],
    set: tuple[2],
    collectorNumber: tuple[3],
    manaCost: tuple[4],
    cmc: tuple[5],
    colors: decodeColors(tuple[6]),
    typeLine: tuple[7],
    rarity: decodeRarity(tuple[8]),
    imageSmall: tuple[9] === '' ? null : tuple[9],
    imageNormal: tuple[10] === '' ? null : tuple[10],
    source: 'scryfall',
  };
}

function isCompactCard(value: unknown): value is CompactCard {
  return (
    Array.isArray(value) &&
    value.length === 11 &&
    typeof value[0] === 'string' &&
    typeof value[5] === 'number' &&
    typeof value[6] === 'string'
  );
}

/**
 * Arena grpId → card facts, held in memory for the life of the app.
 *
 * Built in layers: MTGA's own SQLite database supplies names for every card
 * immediately, and the Scryfall bulk download later fills in mana costs and
 * art. Either layer alone is enough for the app to be useful.
 */
export class CardDatabase {
  private readonly cards: Map<number, CardInfo>;
  private updatedAtValue = '';

  constructor(cards: Map<number, CardInfo>) {
    this.cards = cards;
  }

  get(grpId: number): CardInfo | undefined {
    return this.cards.get(grpId);
  }

  /** The set code for a card, or null — used to label a draft. */
  setForCard(grpId: number): string | null {
    return this.cards.get(grpId)?.set ?? null;
  }

  get size(): number {
    return this.cards.size;
  }

  /** Scryfall's updated_at for the data behind this database. */
  get updatedAt(): string {
    return this.updatedAtValue;
  }

  /** @internal — set by the loader so the UI can show how fresh the data is. */
  withUpdatedAt(updatedAt: string): this {
    this.updatedAtValue = updatedAt;
    return this;
  }

  /**
   * Folds a richer database into this one: cards already known get their mana
   * cost and art upgraded, and genuinely new cards are added.
   *
   * @returns how many cards changed or were added.
   */
  enrichFrom(other: CardDatabase): number {
    let changed = 0;

    for (const [grpId, incoming] of other.cards) {
      const existing = this.cards.get(grpId);

      if (existing === undefined) {
        this.cards.set(grpId, incoming);
        changed += 1;
        continue;
      }

      // Only Scryfall data can improve a card, and only if it brings art.
      if (incoming.imageNormal === null && incoming.manaCost === '') continue;

      this.cards.set(grpId, {
        ...existing,
        // Names stay as Arena spells them; they're what the client shows.
        manaCost: incoming.manaCost,
        cmc: incoming.cmc,
        imageSmall: incoming.imageSmall ?? existing.imageSmall,
        imageNormal: incoming.imageNormal ?? existing.imageNormal,
        // Fill the gaps Arena's database leaves.
        colors: existing.colors.length > 0 ? existing.colors : incoming.colors,
        typeLine: existing.typeLine.length > 0 ? existing.typeLine : incoming.typeLine,
        setName: existing.setName.length > 0 ? existing.setName : incoming.setName,
        source: 'scryfall',
      });
      changed += 1;
    }

    return changed;
  }

  /** Batch lookup, for handing a UI exactly the cards it needs. */
  pick(grpIds: Iterable<number>): Record<number, CardInfo> {
    const out: Record<number, CardInfo> = {};
    for (const grpId of grpIds) {
      const card = this.cards.get(grpId);
      if (card !== undefined) out[grpId] = card;
    }
    return out;
  }

  /** The on-disk form, ready to JSON.stringify. */
  toCache(): CacheFileShape {
    const cards: Record<string, CompactCard> = {};
    for (const [grpId, card] of this.cards) {
      cards[String(grpId)] = [
        card.name,
        card.setName,
        card.set,
        card.collectorNumber,
        card.manaCost,
        card.cmc,
        card.colors.join(''),
        card.typeLine,
        card.rarity,
        card.imageSmall ?? '',
        card.imageNormal ?? '',
      ];
    }
    return { version: CACHE_VERSION, updatedAt: this.updatedAtValue, cards };
  }
}

/** Rebuilds a database from a parsed cache file, or null if it's unusable. */
export function databaseFromCache(parsed: unknown): CardDatabase | null {
  if (parsed === null || typeof parsed !== 'object') return null;

  const shape = parsed as Partial<CacheFileShape>;
  if (shape.version !== CACHE_VERSION) return null;
  if (shape.cards === null || typeof shape.cards !== 'object') return null;

  const cards = new Map<number, CardInfo>();
  for (const [key, value] of Object.entries(shape.cards)) {
    const grpId = Number(key);
    if (!Number.isFinite(grpId)) continue;
    if (!isCompactCard(value)) continue;
    cards.set(grpId, decodeCompactCard(grpId, value));
  }

  if (cards.size === 0) return null;
  return new CardDatabase(cards).withUpdatedAt(
    typeof shape.updatedAt === 'string' ? shape.updatedAt : '',
  );
}

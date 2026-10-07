import type { CardInfo, Color, Rarity } from '@drafttracker/core';

/** Bumped whenever the tuple layout changes, invalidating old caches. */
export const CACHE_VERSION = 3;

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
  /**
   * Printings Scryfall has no `arena_id` for, keyed "SET:collectorNumber".
   * Scoped to the keys the Arena database actually references — see
   * `LoadCardDatabaseOptions.wantedPrintings`.
   */
  printings: Record<string, CompactCard>;
  /**
   * Fingerprint of the wanted keys this cache was built against, so a cache
   * built for an older Arena card pool can be told apart from a current one.
   */
  printingKeys?: string;
}

/**
 * A cheap order-independent-enough fingerprint of a key set.
 *
 * Used to notice that Arena's card pool has changed and the printing index
 * needs rebuilding, without hashing anything expensive on every launch.
 */
export function fingerprintKeys(keys: Iterable<string>): string {
  const sorted = [...keys].sort();
  let hash = 0x811c9dc5;
  for (const key of sorted) {
    for (let i = 0; i < key.length; i += 1) {
      hash ^= key.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return `${(hash >>> 0).toString(36)}:${sorted.length}`;
}

/** The key a printing without an `arena_id` is found under. */
export function printingKey(setCode: string, collectorNumber: string): string {
  return `${setCode.toUpperCase()}:${collectorNumber}`;
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

/** The card facts a tuple carries, minus anything that identifies it. */
export type CardFields = Omit<CardInfo, 'id' | 'source'>;

/**
 * Decodes a tuple into card facts.
 *
 * Separate from `decodeCompactCard` because a printing Scryfall has no
 * `arena_id` for has no grpId to attach — the caller supplies identity.
 */
export function decodeCardFields(tuple: CompactCard): CardFields {
  return {
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
  };
}

export function decodeCompactCard(grpId: number, tuple: CompactCard): CardInfo {
  return { id: grpId, ...decodeCardFields(tuple), source: 'scryfall' };
}

/** The inverse of `decodeCardFields`, so a card can be cached verbatim. */
export function encodeCardFields(card: CardFields): CompactCard {
  return [
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

  /**
   * Printings Scryfall has no `arena_id` for, keyed "SET:collectorNumber".
   *
   * Scryfall ingests a new set's cards at prerelease but doesn't attach their
   * Arena ids until some days later. During that window — which is exactly
   * when people are drafting the set — looking cards up by grpId finds
   * nothing, even though Scryfall has the card and its art. Set code plus
   * collector number is the key that works in both worlds, and it's what the
   * Arena database already carries next to every grpId.
   */
  private readonly printings: Map<string, CardFields>;

  private updatedAtValue = '';

  constructor(cards: Map<number, CardInfo>, printings: Map<string, CardFields> = new Map()) {
    this.cards = cards;
    this.printings = printings;
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

  /** How many arena-id-less printings are indexed. */
  get printingCount(): number {
    return this.printings.size;
  }

  /** Fingerprint of the wanted keys this database's printings were built for. */
  get printingKeys(): string {
    return this.printingKeysValue;
  }

  private printingKeysValue = '';

  /** @internal */
  withPrintingKeys(fingerprint: string): this {
    this.printingKeysValue = fingerprint;
    return this;
  }

  /**
   * Every "SET:collectorNumber" key this database's cards can be found under.
   *
   * Handed to the Scryfall download so it indexes only printings that could
   * ever be asked for; the unscoped index runs to ~118,000 entries and 42 MB
   * for a feature that touches a few thousand cards.
   */
  allPrintingKeys(): Set<string> {
    const keys = new Set<string>();
    for (const card of this.cards.values()) {
      if (card.set.length === 0 || card.collectorNumber.length === 0) continue;
      keys.add(printingKey(card.set, card.collectorNumber));
    }
    return keys;
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
   * Two passes, because Scryfall can identify a card two ways. The first
   * matches on `arena_id`; the second catches the set that Scryfall has but
   * hasn't assigned Arena ids to yet, matching on set + collector number
   * instead.
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

      this.cards.set(grpId, mergeCard(existing, incoming));
      changed += 1;
    }

    changed += this.applyPrintings(other);

    return changed;
  }

  /**
   * Pass two: hand art and mana costs to cards Scryfall knows only as
   * printings. Cards that already have art are skipped, so this can never
   * undo a pass-one match.
   */
  private applyPrintings(other: CardDatabase): number {
    if (other.printings.size === 0) return 0;

    let changed = 0;

    for (const [grpId, existing] of this.cards) {
      if (existing.imageNormal !== null) continue;
      if (existing.set.length === 0 || existing.collectorNumber.length === 0) continue;

      const printing = other.printings.get(printingKey(existing.set, existing.collectorNumber));
      if (printing === undefined) continue;

      this.cards.set(grpId, mergeCard(existing, { id: grpId, ...printing, source: 'scryfall' }));
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
      cards[String(grpId)] = encodeCardFields(card);
    }

    const printings: Record<string, CompactCard> = {};
    for (const [key, printing] of this.printings) {
      printings[key] = encodeCardFields(printing);
    }

    return {
      version: CACHE_VERSION,
      updatedAt: this.updatedAtValue,
      cards,
      printings,
      printingKeys: this.printingKeysValue,
    };
  }

  /** @internal — used by the loader to seed the printing index. */
  withPrintings(printings: Map<string, CardFields>): this {
    for (const [key, printing] of printings) this.printings.set(key, printing);
    return this;
  }
}

/**
 * Overlays Scryfall facts onto an Arena-sourced card.
 *
 * Arena wins on anything it actually knows: its names are what the client
 * displays (including Alchemy's "A-" prefixes), and its type lines are the
 * ones the game uses. Scryfall only fills gaps.
 */
function mergeCard(existing: CardInfo, incoming: CardInfo): CardInfo {
  return {
    ...existing,
    manaCost: incoming.manaCost.length > 0 ? incoming.manaCost : existing.manaCost,
    cmc: incoming.cmc > 0 || existing.cmc === 0 ? incoming.cmc : existing.cmc,
    imageSmall: incoming.imageSmall ?? existing.imageSmall,
    imageNormal: incoming.imageNormal ?? existing.imageNormal,
    colors: existing.colors.length > 0 ? existing.colors : incoming.colors,
    typeLine: existing.typeLine.length > 0 ? existing.typeLine : incoming.typeLine,
    setName: existing.setName.length > 0 ? existing.setName : incoming.setName,
    source: 'scryfall',
  };
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

  const printings = new Map<string, CardFields>();
  for (const [key, value] of Object.entries(shape.printings ?? {})) {
    if (!isCompactCard(value)) continue;
    printings.set(key, decodeCardFields(value));
  }

  return new CardDatabase(cards, printings)
    .withUpdatedAt(typeof shape.updatedAt === 'string' ? shape.updatedAt : '')
    .withPrintingKeys(typeof shape.printingKeys === 'string' ? shape.printingKeys : '');
}

import { describe, expect, it } from 'vitest';
import {
  CACHE_VERSION,
  CardDatabase,
  databaseFromCache,
  decodeCardFields,
  fingerprintKeys,
  printingKey,
  type CompactCard,
} from '../src/database.js';
import type { CardInfo } from '@drafttracker/core';

/** A bare Arena-sourced card: a name, a set, a collector number, no art. */
function arenaCard(grpId: number, name: string, set: string, collectorNumber: string): CardInfo {
  return {
    id: grpId,
    name,
    set,
    setName: '',
    collectorNumber,
    manaCost: '',
    cmc: 0,
    colors: [],
    typeLine: '',
    rarity: 'common',
    imageSmall: null,
    imageNormal: null,
    source: 'arena',
  };
}

/** A Scryfall printing that has art but no arena_id — a prerelease set. */
function printing(name: string, manaCost: string, image: string): CompactCard {
  return [
    name,
    'Reality Fracture',
    'FRA',
    '100',
    manaCost,
    2,
    'G',
    'Creature — Plant',
    'rare',
    `${image}/small`,
    `${image}/normal`,
  ];
}

/**
 * A database holding only printings — the state Scryfall is in for a set it
 * has published but not yet attached Arena ids to.
 */
function printingDb(entries: Record<string, CompactCard>): CardDatabase {
  const printings = new Map(
    Object.entries(entries).map(([key, tuple]) => [key, decodeCardFields(tuple)]),
  );
  return new CardDatabase(new Map(), printings);
}

describe('printing index', () => {
  it('is keyed by set and collector number', () => {
    expect(printingKey('fra', '100')).toBe('FRA:100');
  });

  it('round-trips through the cache', () => {
    // A real cache always has arena-id cards too; a cards-less one is treated
    // as corrupt, which is why this test carries one.
    const db = new CardDatabase(
      new Map([[1, arenaCard(1, 'Known', 'FRA', '1')]]),
      new Map([['FRA:100', decodeCardFields(printing('Carnivorous Cultivator', '{1}{G}', 'ab'))]]),
    );
    expect(db.printingCount).toBe(1);

    const restored = databaseFromCache(JSON.parse(JSON.stringify(db.toCache())));
    expect(restored?.printingCount).toBe(1);
    expect(restored?.size).toBe(1);
  });

  it('records which key set the cache was built for', () => {
    const db = printingDb({}).withPrintingKeys(fingerprintKeys(['FRA:100']));
    const restored = databaseFromCache(JSON.parse(JSON.stringify({ ...db.toCache(), cards: { '1': printing('x', '', '') } })));
    expect(restored?.printingKeys).toBe(fingerprintKeys(['FRA:100']));
  });

  it('rejects a cache written before printings existed', () => {
    expect(databaseFromCache({ version: CACHE_VERSION - 1, cards: {} })).toBeNull();
  });
});

describe('CardDatabase.enrichFrom — the set Scryfall has no arena_id for', () => {
  it('gives art to a card matched by set and collector number', () => {
    const arena = new CardDatabase(
      new Map([[106333, arenaCard(106333, 'Carnivorous Cultivator', 'FRA', '100')]]),
    );
    const scryfall = printingDb({
      'FRA:100': printing('Carnivorous Cultivator // Enroot', '{1}{G}', 'front/ab'),
    });

    // This is the whole point: the card cannot be found by arena_id, because
    // Scryfall has not assigned one yet.
    expect(scryfall.get(106333)).toBeUndefined();

    expect(arena.enrichFrom(scryfall)).toBe(1);

    const card = arena.get(106333);
    expect(card?.imageNormal).toBe('front/ab/normal');
    expect(card?.manaCost).toBe('{1}{G}');
    expect(card?.source).toBe('scryfall');
    // Arena's name is what the Arena client shows, so it survives the merge.
    expect(card?.name).toBe('Carnivorous Cultivator');
  });

  it('does not touch a card that already has art', () => {
    const existing = arenaCard(106333, 'Carnivorous Cultivator', 'FRA', '100');
    existing.imageNormal = 'from-elsewhere/normal';
    existing.source = 'scryfall';
    const arena = new CardDatabase(new Map([[106333, existing]]));

    const scryfall = printingDb({
      'FRA:100': printing('Different Art', '{9}', 'front/zz'),
    });

    arena.enrichFrom(scryfall);
    expect(arena.get(106333)?.imageNormal).toBe('from-elsewhere/normal');
  });

  it('matches nothing when the set or collector number is unknown', () => {
    const arena = new CardDatabase(
      new Map([
        [1, arenaCard(1, 'No Set', '', '')],
        [2, arenaCard(2, 'Wrong Collector', 'FRA', '999')],
      ]),
    );
    const scryfall = printingDb({ 'FRA:100': printing('X', '{1}', 'front/ab') });

    expect(arena.enrichFrom(scryfall)).toBe(0);
    expect(arena.get(1)?.imageNormal).toBeNull();
    expect(arena.get(2)?.imageNormal).toBeNull();
  });

  it('still matches by arena_id first', () => {
    const arena = new CardDatabase(new Map([[7, arenaCard(7, 'Known', 'FRA', '1')]]));
    const scryfall = new CardDatabase(
      new Map([
        [
          7,
          {
            ...arenaCard(7, 'Known', 'FRA', '1'),
            manaCost: '{2}',
            imageNormal: 'by-id/normal',
            imageSmall: 'by-id/small',
            source: 'scryfall' as const,
          },
        ],
      ]),
    );

    expect(arena.enrichFrom(scryfall)).toBe(1);
    expect(arena.get(7)?.imageNormal).toBe('by-id/normal');
  });
});

describe('fingerprintKeys', () => {
  it('changes when the key set changes', () => {
    const a = fingerprintKeys(['FRA:1', 'FRA:2']);
    const b = fingerprintKeys(['FRA:1', 'FRA:3']);
    expect(a).not.toBe(b);
  });

  it('ignores ordering, so an unchanged pool never forces a re-download', () => {
    expect(fingerprintKeys(['B:2', 'A:1'])).toBe(fingerprintKeys(['A:1', 'B:2']));
  });

  it('distinguishes sets of different sizes', () => {
    expect(fingerprintKeys(['A:1'])).not.toBe(fingerprintKeys(['A:1', 'A:2']));
  });
});

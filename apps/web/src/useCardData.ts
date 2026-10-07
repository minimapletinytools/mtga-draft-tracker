import { useEffect, useMemo, useRef, useState } from 'react';
import type { CardInfo, DraftTrackerBridge } from '@drafttracker/core';
import { getBridge } from './bridge';

export type CardMap = ReadonlyMap<number, CardInfo>;

/**
 * Batch-fetches card data for the ids a view needs and caches it for the life
 * of the session.
 *
 * The full database is ~35,000 cards, so the renderer never asks for all of
 * it: it asks for exactly the ids on screen, and only for ids it doesn't
 * already hold. Re-requesting when `revision` changes is how the UI recovers
 * the cards it asked for while the database was still downloading.
 */
export function useCardData(ids: number[], revision: unknown): CardMap {
  const cache = useRef(new Map<number, CardInfo>());
  const [, forceRender] = useState(0);

  // A stable key, so the effect doesn't fire on every render.
  const key = useMemo(() => {
    const unique = [...new Set(ids)].sort((a, b) => a - b);
    return unique.join(',');
  }, [ids]);

  useEffect(() => {
    const bridge: DraftTrackerBridge | undefined = getBridge();
    const wanted = key.length === 0 ? [] : key.split(',').map(Number);
    const missing = wanted.filter((id) => !cache.current.has(id));
    if (missing.length === 0 || bridge === undefined) return;

    let cancelled = false;

    void bridge
      .getCards(missing)
      .then((found) => {
        if (cancelled) return;
        for (const [rawId, card] of Object.entries(found)) {
          cache.current.set(Number(rawId), card);
        }
        // Remember the misses too, so an unknown id isn't re-requested forever.
        for (const id of missing) {
          if (!cache.current.has(id)) cache.current.set(id, MISSING);
        }
        forceRender((n) => n + 1);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [key, revision]);

  // Deliberately not memoized: the cache is mutated in place by the fetch
  // above, so a memo keyed on anything coarser than the cache itself would
  // serve a stale map. A few hundred entries is nothing to rebuild per render.
  const view = new Map<number, CardInfo>();
  for (const [id, card] of cache.current) {
    if (card !== MISSING) view.set(id, card);
  }
  return view;
}

/** Sentinel for "the database doesn't know this grpId". */
const MISSING = {
  id: -1,
  name: '',
  set: '',
  setName: '',
  collectorNumber: '',
  manaCost: '',
  cmc: 0,
  colors: [],
  typeLine: '',
  rarity: 'common',
  imageSmall: null,
  imageNormal: null,
} as unknown as CardInfo;

/**
 * Display preferences that outlive a draft.
 *
 * Kept in localStorage rather than in the main process: these are per-window
 * view settings, not draft data, and nothing else needs to know about them.
 */

const CARD_SCALE_KEY = 'drafttracker.cardScale';

/** Matches the size the pack grid was designed at. */
export const DEFAULT_CARD_SCALE = 100;

/** Below this a card is too small to recognise; above 200 a pack stops fitting. */
export const MIN_CARD_SCALE = 50;
export const MAX_CARD_SCALE = 200;

/** The slider moves in steps, so the readout stays a round number. */
export const CARD_SCALE_STEP = 10;

export function clampCardScale(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CARD_SCALE;
  return Math.min(MAX_CARD_SCALE, Math.max(MIN_CARD_SCALE, Math.round(value)));
}

/**
 * Reads a stored scale, falling back to the default for anything missing or
 * nonsensical — a corrupted preference must not leave the grid unusable.
 */
export function parseCardScale(raw: string | null): number {
  if (raw === null) return DEFAULT_CARD_SCALE;

  const trimmed = raw.trim();
  // `Number('')` is 0, which would clamp to the *minimum* and silently shrink
  // every card. A blank value means "nothing stored", not "as small as possible".
  if (trimmed.length === 0) return DEFAULT_CARD_SCALE;

  return clampCardScale(Number(trimmed));
}

/** localStorage throws in some sandboxed contexts; a missing scale is fine. */
function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadCardScale(): number {
  try {
    return parseCardScale(storage()?.getItem(CARD_SCALE_KEY) ?? null);
  } catch {
    return DEFAULT_CARD_SCALE;
  }
}

export function saveCardScale(value: number): void {
  try {
    storage()?.setItem(CARD_SCALE_KEY, String(clampCardScale(value)));
  } catch {
    /* a preference that can't be saved is not worth breaking a draft over */
  }
}

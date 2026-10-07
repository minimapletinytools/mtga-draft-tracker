import type { DraftTrackerBridge } from '@drafttracker/core';

/**
 * The bridge the preload script exposes. Absent when the UI is opened in a
 * plain browser (`pnpm dev`), which is why `useBridge` exists rather than
 * reading `window.drafttracker` directly everywhere.
 */
export function getBridge(): DraftTrackerBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.drafttracker;
}

export function isEmbedded(): boolean {
  return getBridge() !== undefined;
}

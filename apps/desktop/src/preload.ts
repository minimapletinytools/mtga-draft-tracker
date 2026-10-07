// Preload bridge — the pinned contract between the desktop main process and
// the web UI. Compiled to dist/preload.mjs (ESM preload; the renderer runs
// unsandboxed but with contextIsolation on and nodeIntegration off).
import { contextBridge, ipcRenderer } from 'electron';
import type { CardDbState, LiveState } from '@drafttracker/core';
import {
  CHANNEL_CARD_DB,
  CHANNEL_DELETE_DRAFT,
  CHANNEL_DRAFTS_CHANGED,
  CHANNEL_GET_CARDS,
  CHANNEL_GET_DRAFT,
  CHANNEL_GET_PATHS,
  CHANNEL_LIST_DRAFTS,
  CHANNEL_LIVE,
  CHANNEL_REFRESH_CARDS,
  CHANNEL_REVEAL_DRAFT,
} from './ipc.js';

/** Subscribes to a push channel and returns an unsubscribe function. */
function subscribe<T>(channel: string) {
  return (callback: (payload: T) => void): (() => void) => {
    // Electron's listener is typed (event, ...args: any[]); ours is (payload).
    const listener = (_event: unknown, payload: T): void => callback(payload);
    type Listener = Parameters<typeof ipcRenderer.on>[1];
    ipcRenderer.on(channel, listener as unknown as Listener);
    return () => {
      ipcRenderer.removeListener(channel, listener as unknown as Listener);
    };
  };
}

// Shape must match core's DraftTrackerBridge.
contextBridge.exposeInMainWorld('drafttracker', {
  onLive: subscribe<LiveState>(CHANNEL_LIVE),
  onCardDb: subscribe<CardDbState>(CHANNEL_CARD_DB),
  onDraftsChanged: subscribe<void>(CHANNEL_DRAFTS_CHANGED),
  getCards: (grpIds: number[]) => ipcRenderer.invoke(CHANNEL_GET_CARDS, grpIds),
  listDrafts: () => ipcRenderer.invoke(CHANNEL_LIST_DRAFTS),
  getDraft: (draftId: string) => ipcRenderer.invoke(CHANNEL_GET_DRAFT, draftId),
  deleteDraft: (draftId: string) => ipcRenderer.invoke(CHANNEL_DELETE_DRAFT, draftId),
  revealDraft: (draftId: string) => ipcRenderer.invoke(CHANNEL_REVEAL_DRAFT, draftId),
  refreshCardData: () => ipcRenderer.invoke(CHANNEL_REFRESH_CARDS),
  getPaths: () => ipcRenderer.invoke(CHANNEL_GET_PATHS),
});

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inferSetCode,
  type AppPaths,
  type CardDbState,
  type CardInfo,
  type Draft,
  type LiveState,
} from '@drafttracker/core';
import { DraftTracker, resolvePlayerLogPath } from '@drafttracker/arena';
import { CardDatabase, findArenaCardDatabasePath, loadArenaCardDatabase, loadCardDatabase } from '@drafttracker/cards';
import { DraftStore } from './storage.js';
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

const here = path.dirname(fileURLToPath(import.meta.url));

// Must match productName in electron-builder.yml: this decides the folder
// under ~/Library/Application Support where drafts are saved.
app.setName('Draft Tracker');

/** How long to wait between in-progress autosaves while picks are landing. */
const IN_PROGRESS_DEBOUNCE_MS = 1500;

const assets = fs.existsSync(path.join(here, 'assets'))
  ? path.join(here, 'assets')
  : path.join(here, '../assets');
const windowIconPath = path.join(assets, 'icon.png');
const dockIconPath = path.join(assets, 'icon-mac.png');

// Latest known state, kept so a renderer that reloads (or a newly created
// window) can recover it instead of waiting for the next tracker event.
let latestLive: LiveState = {
  status: 'waiting',
  draft: null,
  pickCount: 0,
  message: null,
};
let latestCardDb: CardDbState = {
  phase: 'idle',
  receivedBytes: 0,
  totalBytes: null,
  cardCount: 0,
  source: null,
  message: null,
};

let tracker: DraftTracker | null = null;
let cardDatabase: CardDatabase | null = null;
/** Whether the Scryfall layer has been folded in this session. */
let scryfallLoaded = false;
let store: DraftStore | null = null;
let cardLoadAbort: AbortController | null = null;

let inProgressTimer: ReturnType<typeof setTimeout> | null = null;
let pendingInProgress: Draft | null = null;

// ------------------------------------------------------------------ broadcast

function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function broadcastLive(state: LiveState): void {
  latestLive = state;
  broadcast(CHANNEL_LIVE, state);
}

function broadcastCardDb(state: CardDbState): void {
  latestCardDb = state;
  broadcast(CHANNEL_CARD_DB, state);
}

// ------------------------------------------------------------------- planning

/**
 * Where the Scryfall cache lives.
 *
 * Deliberately not `userData/cache`: Chromium already treats that directory as
 * its own HTTP disk cache and will happily scatter its files through it.
 */
function cardDataDir(): string {
  return path.join(app.getPath('userData'), 'card-data');
}

function paths(): AppPaths {
  return {
    logPath: resolvePlayerLogPath(),
    draftsDir: store?.dir ?? '',
    cacheDir: cardDataDir(),
  };
}

/**
 * Fills in a set code for a draft that finished before the card database was
 * ready, so history entries aren't labelled "unknown set" forever.
 */
function refineSetCode(draft: Draft): Draft {
  if (draft.setCode !== null || cardDatabase === null) return draft;

  const ids: number[] = [];
  for (const pick of draft.picks) ids.push(...pick.cardsSeen);

  const set = inferSetCode(ids, (grpId) => cardDatabase?.setForCard(grpId) ?? null);
  return set === null ? draft : { ...draft, setCode: set };
}

// ------------------------------------------------------------------ persisting

function scheduleInProgressSave(draft: Draft): void {
  pendingInProgress = draft;
  if (inProgressTimer !== null) return;

  inProgressTimer = setTimeout(() => {
    inProgressTimer = null;
    const pending = pendingInProgress;
    pendingInProgress = null;
    if (pending === null || store === null) return;

    void store
      .saveInProgress(pending)
      .catch((err: unknown) => console.error('[drafttracker] in-progress save failed:', err));
  }, IN_PROGRESS_DEBOUNCE_MS);
  inProgressTimer.unref?.();
}

async function persistFinishedDraft(draft: Draft): Promise<void> {
  if (store === null) return;

  try {
    await store.save(refineSetCode(draft));
    // A finished draft is no longer "in progress"; if the deck lands later the
    // draft file is simply rewritten with it attached.
    if (draft.status !== 'in-progress') await store.clearInProgress();
    broadcast(CHANNEL_DRAFTS_CHANGED);
  } catch (err) {
    console.error('[drafttracker] failed to save draft:', err);
  }
}

// -------------------------------------------------------------------- tracking

function setupTracker(): void {
  const logPath = resolvePlayerLogPath();
  if (logPath === null) {
    broadcastLive({
      status: 'no-log',
      draft: null,
      pickCount: 0,
      message: `Draft Tracker doesn't know where MTG Arena keeps its log on ${process.platform}.`,
    });
    return;
  }

  try {
    const newTracker = new DraftTracker({
      logPath,
      // Reads through a closure, so it starts working the moment the card
      // database finishes downloading — even mid-draft.
      setForCard: (grpId) => cardDatabase?.setForCard(grpId) ?? null,
      onLive: (state) => {
        broadcastLive(state);
        if (state.draft !== null && state.draft.status === 'in-progress') {
          scheduleInProgressSave(state.draft);
        }
      },
      onDraftFinished: (draft) => void persistFinishedDraft(draft),
      onDeckCaptured: (draft) => void persistFinishedDraft(draft),
    });
    tracker = newTracker;

    // Recover a draft that was live when the app last closed, *before* the log
    // replay starts so the replay merges into it rather than being overwritten.
    // If the replay turns out to have nothing about that draft, the tracker
    // closes it out as abandoned by itself.
    void store
      ?.loadInProgress()
      .then((draft) => {
        if (draft !== null && draft.status === 'in-progress') newTracker.restore(draft);
      })
      .catch(() => {})
      .finally(() => newTracker.start());
  } catch (err) {
    console.error('[drafttracker] failed to start the draft tracker:', err);
    broadcastLive({
      status: 'parse-error',
      draft: null,
      pickCount: 0,
      message: `Could not start log tracking: ${(err as Error).message}`,
    });
  }
}

// --------------------------------------------------------------- card database

/**
 * Loads card data in two layers.
 *
 * Arena's own SQLite database comes first — it is local, takes ~70 ms, and is
 * current even on the day a set releases. The Scryfall bulk download runs
 * afterwards in the background and only adds what Arena doesn't have: mana
 * costs and card art. Either layer alone is enough to run the app.
 */
async function setupCardDatabase(forceRefresh = false): Promise<CardDbState> {
  if (cardDatabase === null && !forceRefresh) {
    const localPath = findArenaCardDatabasePath();
    if (localPath !== null) {
      try {
        cardDatabase = loadArenaCardDatabase(localPath);
        broadcastCardDb({
          phase: 'idle',
          receivedBytes: 0,
          totalBytes: null,
          cardCount: cardDatabase.size,
          source: 'arena',
          message: null,
        });
        // The UI has been showing raw grpIds until now; have it re-resolve.
        broadcastLive(latestLive);
      } catch (err) {
        console.error('[drafttracker] could not read Arena’s card database:', err);
      }
    }
  }

  if (scryfallLoaded && !forceRefresh) return latestCardDb;

  cardLoadAbort?.abort();
  const abort = new AbortController();
  cardLoadAbort = abort;

  try {
    const scryfall = await loadCardDatabase({
      cacheDir: cardDataDir(),
      forceRefresh,
      // Scoping the printing index to Arena's own card pool is what keeps the
      // cache near 8 MB; unscoped it is ~42 MB.
      wantedPrintings: cardDatabase?.allPrintingKeys(),
      // Progress is reported in bytes; the card count stays whatever the app
      // can actually resolve right now, which is what the UI displays.
      onProgress: (state) =>
        broadcastCardDb({
          ...state,
          cardCount: cardDatabase?.size ?? state.cardCount,
          source: cardDatabase === null ? null : 'arena',
        }),
      signal: abort.signal,
    });

    if (cardDatabase === null) {
      cardDatabase = scryfall;
    } else {
      cardDatabase.enrichFrom(scryfall);
    }
    scryfallLoaded = true;

    broadcastCardDb({
      phase: 'ready',
      receivedBytes: 0,
      totalBytes: null,
      cardCount: cardDatabase.size,
      source: 'scryfall',
      message: null,
    });
    broadcastLive(latestLive);
    return latestCardDb;
  } catch (err) {
    // Already reported through onProgress; the app keeps working without it.
    console.error('[drafttracker] Scryfall card data unavailable:', err);
    return latestCardDb;
  } finally {
    if (cardLoadAbort === abort) cardLoadAbort = null;
  }
}

// ---------------------------------------------------------------------- window

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0e1016',
    title: 'Draft Tracker',
    icon: windowIconPath, // Windows/Linux only; macOS takes its icon from the dock.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(here, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // ESM preload requires an unsandboxed renderer
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env['DRAFTTRACKER_DEV_URL'];
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    const webDistPath = fs.existsSync(path.join(here, 'web/index.html'))
      ? path.join(here, 'web/index.html')
      : path.join(here, '../../web/dist/index.html');
    void win.loadFile(webDistPath);
  }

  // Reloads (or a fresh window) miss whatever events already fired — replay
  // the latest known state so the UI recovers without waiting on the tracker.
  win.webContents.on('did-finish-load', () => {
    win.webContents.send(CHANNEL_LIVE, latestLive);
    win.webContents.send(CHANNEL_CARD_DB, latestCardDb);
  });

  return win;
}

// ------------------------------------------------------------------------- ipc

function registerIpc(): void {
  ipcMain.handle(CHANNEL_GET_CARDS, (_event, rawIds: unknown): Record<number, CardInfo> => {
    if (cardDatabase === null || !Array.isArray(rawIds)) return {};
    const ids: number[] = [];
    for (const value of rawIds) {
      if (typeof value === 'number' && Number.isFinite(value)) ids.push(value);
    }
    return cardDatabase.pick(ids);
  });

  ipcMain.handle(CHANNEL_LIST_DRAFTS, async () => (store === null ? [] : store.list()));

  ipcMain.handle(CHANNEL_GET_DRAFT, async (_event, draftId: unknown) => {
    if (store === null || typeof draftId !== 'string') return null;
    return store.load(draftId);
  });

  ipcMain.handle(CHANNEL_DELETE_DRAFT, async (_event, draftId: unknown) => {
    if (store === null || typeof draftId !== 'string') return;
    await store.remove(draftId);
    broadcast(CHANNEL_DRAFTS_CHANGED);
  });

  ipcMain.handle(CHANNEL_REVEAL_DRAFT, (_event, draftId: unknown) => {
    if (store === null || typeof draftId !== 'string') return;
    shell.showItemInFolder(store.filePath(draftId));
  });

  ipcMain.handle(CHANNEL_REFRESH_CARDS, async () => setupCardDatabase(true));

  ipcMain.handle(CHANNEL_GET_PATHS, () => paths());
}

// ----------------------------------------------------------------------- start

/** A missing or unreadable icon must never stop the app from starting. */
function applyDockIcon(): void {
  if (process.platform !== 'darwin') return;
  if (!fs.existsSync(dockIconPath)) return;
  try {
    // Electron's types say void, but on macOS this actually returns a promise
    // that rejects if the image can't be decoded. Handle both shapes.
    const result: unknown = app.dock?.setIcon(dockIconPath);
    if (result instanceof Promise) result.catch(() => {});
  } catch (err) {
    console.error('[drafttracker] could not set the dock icon:', err);
  }
}

/**
 * Only one copy of this app may run at a time.
 *
 * Two instances would both tail the same log and both write the same draft
 * files, and the write queue that keeps a single process's saves ordered is
 * per-process — it can't serialize across them.
 *
 * `make run` makes this easy to hit, since it launches without checking.
 */
const isPrimaryInstance = app.requestSingleInstanceLock();

if (!isPrimaryInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows();
    if (existing === undefined) return;
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
  });

  void startApp();
}

async function startApp(): Promise<void> {
  try {
    await app.whenReady();

    // Unpackaged macOS runs (`electron .`) show the stock Electron icon in the
    // dock unless we override it; a packaged build gets it from icon.icns.
    applyDockIcon();

    store = new DraftStore(path.join(app.getPath('userData'), 'drafts'));

    registerIpc();
    createWindow();

    setupTracker();
    // Deliberately not awaited: a first run downloads ~79 MB of card data, and
    // draft tracking must work the whole time it's in flight.
    void setupCardDatabase();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  } catch (err) {
    console.error('[drafttracker] failed to start:', err);
    app.quit();
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  cardLoadAbort?.abort();
  try {
    tracker?.stop();
  } catch (err) {
    console.error('[drafttracker] error stopping the tracker:', err);
  } finally {
    tracker = null;
  }
});

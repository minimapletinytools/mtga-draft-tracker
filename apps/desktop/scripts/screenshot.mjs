/**
 * Renders the built web UI in Electron and writes PNG screenshots, so the
 * layout can actually be looked at without a human at the keyboard.
 *
 *   pnpm --filter @drafttracker/web build
 *   node apps/desktop/scripts/screenshot.mjs [outDir]
 *
 * The page loads without the preload bridge, so the dev fixture drives it.
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const webDist = path.join(repoRoot, 'apps/web/dist/index.html');
const outDir = process.argv[2] ?? path.join(repoRoot, '.screenshots');

const SIZE = { width: 1440, height: 900 };

/** name → actions to run against the loaded page before capturing. */
const SHOTS = [
  { name: '01-live-draft', setup: null },
  { name: '02-pick-history', setup: 'history-scrollback' },
  { name: '03-history-list', setup: 'open-history' },
  { name: '04-saved-draft', setup: 'open-first-saved' },
  { name: '05-pack-1-pick-1', setup: 'jump-to-first-pick' },
];

async function clickByText(win, text) {
  const escaped = JSON.stringify(text);
  return win.webContents.executeJavaScript(`
    (() => {
      const wanted = ${escaped};
      const nodes = [...document.querySelectorAll('button')];
      const match = nodes.find((n) => n.textContent.trim().startsWith(wanted));
      if (!match) return 'not-found';
      match.click();
      return 'clicked';
    })()
  `);
}

/** Electron's sendInputEvent takes DOM-style key names, not `KeyboardEvent.key`. */
const KEY_CODES = {
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  End: 'End',
};

async function press(win, key, times = 1) {
  const keyCode = KEY_CODES[key] ?? key;
  for (let i = 0; i < times; i += 1) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    win.webContents.sendInputEvent({ type: 'char', keyCode });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
    await delay(20);
  }
}

async function packHeading(win) {
  return win.webContents.executeJavaScript(
    `document.querySelector('.pack-header h2')?.textContent ?? null`,
  );
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  mkdirSync(outDir, { recursive: true });

  const win = new BrowserWindow({
    ...SIZE,
    show: false,
    backgroundColor: '#0d0f15',
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: false },
  });

  // The UI is designed to sit under a hidden-inset title bar; emulate that.
  await win.loadFile(webDist, { query: { instant: '1' } });
  // Let the fixture's card lookups resolve and images decode.
  await delay(2500);

  for (const shot of SHOTS) {
    if (shot.setup === 'history-scrollback') {
      // Prove the keyboard shortcuts actually move the selection.
      const before = await packHeading(win);
      await press(win, 'ArrowUp', 1);
      await press(win, 'ArrowLeft', 3);
      const after = await packHeading(win);
      console.log(`keyboard nav: ${before} -> ${after}`);
      if (before === after) throw new Error('arrow keys did not change the selected pick');
    } else if (shot.setup === 'open-history') {
      await clickByText(win, 'History');
    } else if (shot.setup === 'open-first-saved') {
      await clickByText(win, 'History');
      await delay(400);
      await win.webContents.executeJavaScript(`
        (() => {
          const rows = [...document.querySelectorAll('.history-open')];
          if (rows.length > 1) rows[1].click();
          else if (rows.length > 0) rows[0].click();
        })()
      `);
    } else if (shot.setup === 'jump-to-first-pick') {
      await clickByText(win, 'Live draft');
      await delay(300);
      await win.webContents.executeJavaScript(`
        (() => {
          const cells = [...document.querySelectorAll('.rail-cell')];
          if (cells.length) cells[0].click();
        })()
      `);
    }

    await delay(700);
    const image = await win.webContents.capturePage();
    const file = path.join(outDir, `${shot.name}.png`);
    writeFileSync(file, image.toPNG());
    console.log(`wrote ${path.relative(repoRoot, file)}`);
  }

  // A layout dump is easier to diff than a picture when something regresses.
  const report = await win.webContents.executeJavaScript(`
    (() => ({
      picks: document.querySelectorAll('.rail-cell').length,
      packTiles: document.querySelectorAll('.pack-grid .tile').length,
      poolTiles: document.querySelectorAll('.pool-grid .tile').length,
      tilesWithArt: [...document.querySelectorAll('.tile img')].length,
      title: document.querySelector('.pack-header h2')?.textContent ?? null,
      taken: document.querySelector('.pack-taken-name')?.textContent ?? null,
      bodyOverflow: document.body.scrollHeight > window.innerHeight,
    }))()
  `);
  console.log(JSON.stringify(report, null, 2));

  app.quit();
}

void ipcMain;
app.whenReady().then(() =>
  run().catch((err) => {
    console.error(err);
    app.exit(1);
  }),
);

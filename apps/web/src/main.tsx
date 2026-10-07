import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

/**
 * In a plain browser there is no preload script, so stand in a bridge backed by
 * the bundled sample draft — that's what makes `pnpm dev` useful for UI work.
 *
 * The bridge is installed before the first render, because App reads it once:
 * a bridge that arrived a tick later would be invisible to it. A dynamic
 * import keeps the 80 KB of fixture data out of the packaged app entirely.
 */
async function start(): Promise<void> {
  if (typeof window !== 'undefined' && window.drafttracker === undefined) {
    const { installDevBridge } = await import('./dev/devBridge');
    installDevBridge();
  }

  const container = document.getElementById('root');
  if (container === null) throw new Error('#root is missing from index.html');

  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();

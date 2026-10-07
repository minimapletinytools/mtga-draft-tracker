import os from 'node:os';
import path from 'node:path';

/**
 * Locate the MTGA `Player.log` for the current platform, or `null` when the
 * platform isn't supported. Callers treat `null` as "no tracking available"
 * and degrade to a status the UI can explain.
 */
export function resolvePlayerLogPath(platform: NodeJS.Platform = process.platform): string | null {
  switch (platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library/Logs/Wizards Of The Coast/MTGA/Player.log');
    case 'win32':
      return path.join(
        os.homedir(),
        'AppData',
        'LocalLow',
        'Wizards Of The Coast',
        'MTGA',
        'Player.log',
      );
    default:
      return null;
  }
}

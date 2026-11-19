import path from "node:path";
import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { parseInbox, legacyIdRenames } from "./inbox-parse";
import { syncInboxState } from "./inbox-state";
import { getConfig } from "./config";

/**
 * Watch inbox-shared.md and stamp new entries with the moment they appeared.
 *
 * Why a watcher and not just the API route: entry ids are supposed to carry the
 * posting time, but many are written without it, and the fallback (when the
 * server first saw the entry) is only honest if the server is actually looking.
 * The dashboard runs under pm2 around the clock, so watching here means an
 * entry posted at 2am is stamped 2am, not stamped whenever the owner next opens a
 * browser tab.
 *
 * Failure is non-fatal in every direction: no watcher just means the API's
 * backstop does the stamping, at lower precision.
 */

let watcher: FSWatcher | null = null;
let debounce: NodeJS.Timeout | null = null;

async function stampCurrentEntries(inboxPath: string): Promise<void> {
  try {
    const text = await readFile(inboxPath, "utf8");
    const entries = parseInbox(text);
    if (entries.length > 0) {
      await syncInboxState(entries.map((e) => e.id), legacyIdRenames(entries));
    }
  } catch {
    // Mid-write or missing file: the next change event picks it up.
  }
}

export function startInboxWatcher(): void {
  if (watcher) return;
  const inboxPath = path.join(getConfig().aiteamDir, "inbox-shared.md");

  // Stamp once at startup so entries written while the server was down get a
  // time (the restart moment) rather than none at all.
  void stampCurrentEntries(inboxPath);

  try {
    watcher = watch(inboxPath, { persistent: false }, () => {
      // fs.watch fires several events per save on Windows; one pass is enough.
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        void stampCurrentEntries(inboxPath);
      }, 500);
    });
    watcher.on("error", () => {
      watcher = null;
    });
  } catch {
    // File missing at boot: the API backstop covers it.
    watcher = null;
  }
}

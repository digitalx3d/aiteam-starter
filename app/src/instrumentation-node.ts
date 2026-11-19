import path from "node:path";
import { reconcileStrandedDispatches } from "@/lib/dispatch-reconcile";

/**
 * Node-only startup housekeeping, loaded from instrumentation.ts only when
 * NEXT_RUNTIME is "nodejs". Kept in its own file, as the Next docs recommend,
 * so the Edge bundle never traces node:path, node:fs or process.cwd().
 */
export async function registerNode(): Promise<void> {
  try {
    // Same location dispatch-store and the dispatch route use: cwd/.dispatches.
    const dir = path.join(process.cwd(), ".dispatches");
    const r = await reconcileStrandedDispatches(dir);
    if (r.strandedCount > 0) {
      console.log(
        `[dispatch] closed ${r.strandedCount} ticket(s) stranded by a restart: ${r.ids.join(", ")}`
      );
    }
  } catch (err) {
    // Never let startup housekeeping stop the server coming up.
    console.error("[dispatch] reconciliation failed:", err);
  }

  // Dispatch queue: jobs waiting in ~/.aiteam/dispatch-queue.json survive a
  // restart, but the sweeper that releases them lives in the dispatch route's
  // bundle (it has to: that's where workers are started) and only starts when
  // the route is first hit. Hit it once, shortly after boot, so nothing waits
  // for a human to open the dashboard. Next records this process's own origin
  // in __NEXT_PRIVATE_ORIGIN after it binds; without it, skip quietly.
  setTimeout(() => {
    const origin = process.env.__NEXT_PRIVATE_ORIGIN;
    if (!origin) return;
    fetch(`${origin}/api/dispatch`).catch((err) =>
      console.error("[dispatch-queue] boot wake-up failed:", (err as Error).message)
    );
  }, 15_000).unref?.();

  try {
    // Watches inbox-shared.md so a new entry is stamped with the minute it was
    // posted, whether or not anyone has the dashboard open. See inbox-watch.ts.
    const { startInboxWatcher } = await import("@/lib/inbox-watch");
    startInboxWatcher();
  } catch (err) {
    console.error("[inbox] watcher failed to start:", err);
  }
}

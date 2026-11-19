/**
 * Catches a worker that ends its run while background jobs it started are
 * still going. Claude Code stops those jobs when the session closes, so a long
 * job started with the Bash tool's run_in_background dies with the turn (the
 * 2026-10-07 billing baseline died at 8 of 30 this way).
 *
 * The signal is structural, not wording: the stream-json transcript carries a
 * `background_tasks_changed` system event listing the open tasks every time the
 * set changes, and a `result` event when the turn ends. Whatever is open at the
 * last `result` is what got stopped at session end.
 */

export interface OpenBackgroundTask {
  taskId: string;
  description: string;
}

export class BackgroundTaskTracker {
  private open: OpenBackgroundTask[] = [];
  private openAtLastResult: OpenBackgroundTask[] = [];

  /** Feed one stream-json line. Lines that aren't JSON are ignored. */
  observe(line: string): void {
    // Cheap pre-check: only two event shapes matter, skip parsing the rest.
    if (!line.includes("background_tasks_changed") && !line.includes('"result"')) return;
    let ev: { type?: string; subtype?: string; tasks?: unknown };
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type === "system" && ev.subtype === "background_tasks_changed" && Array.isArray(ev.tasks)) {
      this.open = ev.tasks
        .filter((t): t is { task_id?: unknown; description?: unknown } => !!t && typeof t === "object")
        .map((t) => ({
          taskId: String(t.task_id ?? ""),
          description: String(t.description ?? "").slice(0, 160),
        }));
    } else if (ev.type === "result") {
      this.openAtLastResult = [...this.open];
    }
  }

  /** Background tasks still running when the worker's final turn ended. */
  stoppedAtEnd(): OpenBackgroundTask[] {
    return this.openAtLastResult;
  }
}

/** One-paragraph warning for CVB, or null when nothing was left running. */
export function backgroundTaskWarning(tasks: OpenBackgroundTask[]): string | null {
  if (tasks.length === 0) return null;
  const list = tasks.map((t) => `"${t.description || t.taskId}"`).join(", ");
  const one = tasks.length === 1;
  return (
    `[run-job check] This worker ended with ${tasks.length} background job${one ? "" : "s"} ` +
    `still running, and ${one ? "it was" : "they were"} stopped when its session closed: ${list}. ` +
    `If ${one ? "it was" : "any of them was"} meant to finish, ${one ? "it" : "that one"} did not. ` +
    `Long jobs belong in the job runner (scripts/run-job.md in the aiTeam folder).`
  );
}

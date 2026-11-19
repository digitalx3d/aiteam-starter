# Dispatch queue

Start a job only after another one finishes successfully, so a chain of work
(copy first, then the image that goes with it) runs without CVB waking up
between steps.

## How it works

Three commands, run from any folder. Use the absolute path to your aiTeam
folder; the examples below use `<aiTeam>` for it.

```
node <aiTeam>/scripts/dispatch.mjs --agent maya --project my-app --after <ticketId> --brief-file cover.md
node <aiTeam>/scripts/dispatch.mjs --queue
node <aiTeam>/scripts/dispatch.mjs --cancel <ticketId>
```

- `--after <ticketId>` returns a ticket id at once, like any dispatch, and the
  job waits. `<ticketId>` is the full id a dispatch printed, or its first 8
  characters. For a chain, queue C `--after` the id B's dispatch returned.
- **It starts when the earlier job finishes successfully.** If that job fails,
  is cancelled, or its worker's last Live Feed post is a blocker, the waiting
  job does not start. It shows as "waiting on a failed job", its board task
  turns blocked, and a report saying so lands in the chat it was dispatched
  from. Everything further down the chain stops too.
- **Usage limit.** If the earlier job died on the Claude usage limit, the
  waiting job is held and the chat is told until when. Two minutes after the
  reset, the queue re-runs the job that died (same agent, brief and board task,
  with a note to check what the first run already finished), and the chain
  carries on behind the re-run. At most two re-runs; a third limit in a row
  stops the chain like any failure. Do not re-dispatch the dead job by hand
  while its waiters are held, or it runs twice.
- **Visible** on the board task ("Queued after Casey's job 3f2a9c1e"), in a
  "Waiting in line" section on the project's Agents tab, and in `--queue`.
- **At most 10 jobs wait at once**, across all projects. The 11th `--after` is
  refused in plain words.
- **Survives a restart.** Waiting jobs live in `~/.aiteam/dispatch-queue.json`,
  a file of their own; ticket files are unchanged. Only the dashboard running
  on your `appPort` starts queued jobs. A lock on the file, plus a ticket file
  that can only be created once, means a job can never start twice.

## How to undo

### Switch it off (no rebuild, no restart)

Add `"dispatchQueue": false` to `~/.aiteam/settings.json`, or run this from any
folder:

```
node -e "const f=require('os').homedir()+'/.aiteam/settings.json';const s=JSON.parse(require('fs').readFileSync(f,'utf8'));s.dispatchQueue=false;require('fs').writeFileSync(f,JSON.stringify(s,null,2))"
```

On Windows, don't save the file from PowerShell's `Set-Content`: it adds a
byte-order mark and the dashboard then ignores every setting in the file.

It takes effect on the next request. `--after` is refused with a message saying
the queue is off; nothing new is queued; anything already waiting is NOT
started, and stays listed (`--queue`) and cancellable (`--cancel`). To switch it
back on, set it to `true` or delete the line.

### Clean up after switching it off

Cancel anything still waiting (`--queue`, then `--cancel <ticketId>`), then
delete `~/.aiteam/dispatch-queue.json` (and `dispatch-queue.json.lock` beside
it, if present). Board tasks the queue created stay as ordinary tasks.
Dispatches without `--after` never touch the queue.

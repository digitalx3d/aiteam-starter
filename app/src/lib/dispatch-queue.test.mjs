// Tests for the dispatch queue (dispatch.mjs --after). Run from the app/ folder:
//   node --test src/lib/dispatch-queue.test.mjs
// Node 22.18+ strips the TypeScript types on import, so no build step.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const Q = await import("./dispatch-queue.ts");

function tempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dq-test-"));
  const dispatchesDir = path.join(dir, ".dispatches");
  fs.mkdirSync(dispatchesDir);
  return { file: path.join(dir, "dispatch-queue.json"), dispatchesDir, dir };
}

function writeTicket(env, id, status, extra = {}) {
  fs.writeFileSync(
    path.join(env.dispatchesDir, `${id}.json`),
    JSON.stringify({ id, agent: extra.agent ?? "casey", status, errorMessage: null, finishedAt: null, ...extra })
  );
}

function queue(env, after, agent = "maya") {
  const res = Q.enqueue(env, {
    id: randomUUID(),
    after,
    agent,
    project: "bakery-site",
    brief: `${agent} does a thing`,
    model: null,
    effort: null,
    securityReview: false,
    taskId: null,
    taskOwned: false,
  });
  assert.equal(res.ok, true, res.error);
  return res.job;
}

const stateOf = (env, id) => Q.listJobs(env).find((j) => j.id === id)?.state;

test("a waiting job is released once its predecessor finishes, and only once", () => {
  const env = tempEnv();
  const a = randomUUID();
  writeTicket(env, a, "running");
  const b = queue(env, a);

  assert.deepEqual(Q.planSweep(env).release, []);
  assert.equal(stateOf(env, b.id), "waiting");

  writeTicket(env, a, "done");
  const plan = Q.planSweep(env);
  assert.deepEqual(plan.release.map((j) => j.id), [b.id]);
  assert.equal(stateOf(env, b.id), "released");
  assert.deepEqual(Q.planSweep(env).release, [], "a second sweep must not release it again");
});

test("a chain of three runs in order: C waits on B's queued id until B finishes", () => {
  const env = tempEnv();
  const a = randomUUID();
  writeTicket(env, a, "running");
  const b = queue(env, a, "maya");
  const c = queue(env, b.id, "devin");

  writeTicket(env, a, "done");
  assert.deepEqual(Q.planSweep(env).release.map((j) => j.id), [b.id]);
  // B is released but its ticket is still being written: C keeps waiting.
  assert.deepEqual(Q.planSweep(env).release, []);
  writeTicket(env, b.id, "running", { agent: "maya" });
  assert.deepEqual(Q.planSweep(env).release, []);
  assert.equal(stateOf(env, c.id), "waiting");
  writeTicket(env, b.id, "done", { agent: "maya" });
  assert.deepEqual(Q.planSweep(env).release.map((j) => j.id), [c.id]);
});

test("a failure stops the chain: everything behind it is blocked and reported once", () => {
  const env = tempEnv();
  const a = randomUUID();
  writeTicket(env, a, "running");
  const b = queue(env, a);
  const c = queue(env, b.id, "devin");

  writeTicket(env, a, "failed", { errorMessage: "exit code 1: boom" });
  const plan = Q.planSweep(env);
  assert.deepEqual(plan.release, []);
  assert.deepEqual(plan.blocked.map((j) => j.id).sort(), [b.id, c.id].sort());
  assert.match(plan.blocked.find((j) => j.id === b.id).reason, /casey's job .* failed: exit code 1: boom/);
  assert.match(plan.blocked.find((j) => j.id === c.id).reason, /itself waiting on a failed job/);

  Q.markNotified(env, plan.blocked.map((j) => j.id));
  assert.deepEqual(Q.planSweep(env).blocked, [], "reported once, not on every sweep");
  assert.equal(stateOf(env, c.id), "blocked", "still listed (and cancellable)");
});

test("a failed middle job leaves the third waiting on a failed job", () => {
  const env = tempEnv();
  const a = randomUUID();
  writeTicket(env, a, "done");
  const b = queue(env, a);
  const c = queue(env, b.id, "devin");
  assert.deepEqual(Q.planSweep(env).release.map((j) => j.id), [b.id]);
  writeTicket(env, b.id, "failed", { agent: "maya", errorMessage: "API Error: 529 Overloaded" });
  const plan = Q.planSweep(env);
  assert.deepEqual(plan.release, []);
  assert.deepEqual(plan.blocked.map((j) => j.id), [c.id]);
  assert.match(plan.blocked[0].reason, /maya's job .* failed: API Error: 529/);
});

test("a cancelled predecessor and a worker that reported blocked both stop the chain", () => {
  const env = tempEnv();
  const a = randomUUID();
  const d = randomUUID();
  writeTicket(env, a, "running");
  writeTicket(env, d, "running");
  const b = queue(env, a);
  const e = queue(env, d);
  writeTicket(env, a, "cancelled");
  writeTicket(env, d, "done");
  Q.recordBlockedReport(env, d, "blocker [bakery-site] -- the upload page wants a login");
  const plan = Q.planSweep(env);
  assert.deepEqual(plan.release, []);
  assert.match(plan.blocked.find((j) => j.id === b.id).reason, /was cancelled/);
  assert.match(plan.blocked.find((j) => j.id === e.id).reason, /reported blocked .*wants a login/);
});

test("cancel removes a waiting job; whatever waited on it is then blocked", () => {
  const env = tempEnv();
  const a = randomUUID();
  writeTicket(env, a, "running");
  const b = queue(env, a);
  const c = queue(env, b.id, "devin");

  const res = Q.cancel(env, b.id.slice(0, 8));
  assert.equal(res.ok, true);
  assert.equal(stateOf(env, b.id), "cancelled");
  writeTicket(env, a, "done");
  const plan = Q.planSweep(env);
  assert.deepEqual(plan.release, [], "a cancelled job never starts");
  assert.deepEqual(plan.blocked.map((j) => j.id), [c.id]);

  assert.equal(Q.cancel(env, randomUUID()).notFound, true);
  assert.match(Q.cancel(env, b.id).error, /already cancelled/);
});

test("a job that already started can't be cancelled from the queue", () => {
  const env = tempEnv();
  const a = randomUUID();
  writeTicket(env, a, "done");
  const b = queue(env, a);
  Q.planSweep(env);
  assert.match(Q.cancel(env, b.id).error, /already started/);
});

test("no more than 10 jobs wait at once; the 11th is refused in plain words", () => {
  const env = tempEnv();
  const a = randomUUID();
  writeTicket(env, a, "running");
  for (let i = 0; i < Q.MAX_WAITING; i++) queue(env, a);
  const check = Q.checkEnqueue(env, a);
  assert.equal(check.ok, false);
  assert.match(check.error, /the queue is full: 10 jobs are already waiting \(the limit is 10\)/);
  const res = Q.enqueue(env, { ...Q.listJobs(env)[0], id: randomUUID() });
  assert.equal(res.ok, false);

  // Released jobs no longer count against the cap.
  writeTicket(env, a, "done");
  Q.planSweep(env);
  assert.equal(Q.checkEnqueue(env, a).ok, true);
});

test("enqueue refuses a predecessor that already failed or doesn't exist; accepts an 8-character prefix", () => {
  const env = tempEnv();
  const failed = randomUUID();
  writeTicket(env, failed, "failed", { errorMessage: "exit code 1" });
  assert.match(Q.checkEnqueue(env, failed).error, /nothing to wait for/);
  assert.match(Q.checkEnqueue(env, randomUUID()).error, /no ticket or queued job/);
  assert.match(Q.checkEnqueue(env, "not-an-id!").error, /is not a ticket id/);

  const running = randomUUID();
  writeTicket(env, running, "running");
  const check = Q.checkEnqueue(env, running.slice(0, 8));
  assert.equal(check.ok, true);
  assert.equal(check.after, running);
  assert.equal(check.predecessorAgent, "casey");
});

test("a malformed queue file is an error, never silently emptied", () => {
  const env = tempEnv();
  fs.writeFileSync(env.file, "{ not json");
  assert.throws(() => Q.planSweep(env));
  assert.equal(fs.readFileSync(env.file, "utf8"), "{ not json");
});

test("no double start: two processes sweeping the same file release each job exactly once", async () => {
  const env = tempEnv();
  const a = randomUUID();
  writeTicket(env, a, "running");
  const ids = [];
  for (let i = 0; i < Q.MAX_WAITING; i++) ids.push(queue(env, a).id);
  writeTicket(env, a, "done");

  const modUrl = pathToFileURL(path.join(here, "dispatch-queue.ts")).href;
  const script =
    `const Q = await import(${JSON.stringify(modUrl)});` +
    `const env = ${JSON.stringify({ file: env.file, dispatchesDir: env.dispatchesDir })};` +
    `const out = [];` +
    `const until = Date.now() + 1500;` +
    `while (Date.now() < until) for (const j of Q.planSweep(env).release) out.push(j.id);` +
    `process.stdout.write(JSON.stringify(out));`;
  const run = () =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("exit", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err))));
    });
  const [one, two] = await Promise.all([run(), run(), Promise.resolve(Q.planSweep(env).release.map((j) => j.id))]).then(
    ([x, y, z]) => [[...x, ...z], y]
  );
  const all = [...one, ...two].sort();
  assert.deepEqual(all, [...ids].sort(), "every job released, none twice");
});

test("the ticket store refuses to create the same queued id twice", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dq-store-"));
  const prev = process.cwd();
  process.chdir(dir);
  try {
    const store = await import(`./dispatch-store.ts?${Date.now()}`);
    const id = randomUUID();
    const init = { id, agent: "maya", project: null, brief: "x", sessionId: randomUUID(), cwd: dir };
    const t = await store.createTicket(init);
    assert.equal(t.id, id);
    await assert.rejects(store.createTicket(init), /EEXIST/);
    const plain = await store.createTicket({ ...init, id: undefined });
    assert.notEqual(plain.id, id, "without an id, a fresh one as before");
  } finally {
    process.chdir(prev);
  }
});

test("off switch: settings.json dispatchQueue false turns the queue off; default is on", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dq-settings-"));
  const file = path.join(dir, "settings.json");
  process.env.AITEAM_SETTINGS_FILE = file;
  const config = await import(`./config.ts?${Date.now()}`);
  assert.equal(config.isDispatchQueueEnabled(), true, "no settings file: on");

  const write = (obj, tick) => {
    fs.writeFileSync(file, JSON.stringify(obj));
    const t = new Date(Date.now() + tick * 1000);
    fs.utimesSync(file, t, t); // a fresh mtime, so the cache re-reads
  };
  write({ ownerName: "Boss" }, 1);
  assert.equal(config.isDispatchQueueEnabled(), true, "key absent: on");
  write({ dispatchQueue: false }, 2);
  assert.equal(config.isDispatchQueueEnabled(), false, "false: off, no restart needed");
  write({ dispatchQueue: "off" }, 3);
  assert.equal(config.isDispatchQueueEnabled(), false);
  write({ dispatchQueue: true }, 4);
  assert.equal(config.isDispatchQueueEnabled(), true);
  delete process.env.AITEAM_SETTINGS_FILE;
});

// ---------------------------------------------------------------------------
// Usage limit (second commit): hold until the reset, re-run the dead job once,
// then the chain carries on behind the re-run.
// ---------------------------------------------------------------------------

const LIMIT_MSG = (t) => `You've hit your session limit · resets ${t} (Asia/Tokyo) (API 429)`;
// Tokyo is UTC+9 all year (no daylight saving).
const tky = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h - 9, mi);

test("parseLimitReset reads the real message shapes, in the zone they name", () => {
  const failedAt = tky(2026, 10, 27, 21, 30);
  assert.equal(Q.parseLimitReset(LIMIT_MSG("10pm"), failedAt), tky(2026, 10, 27, 22, 0));
  assert.equal(Q.parseLimitReset(LIMIT_MSG("10:50pm"), failedAt), tky(2026, 10, 27, 22, 50));
  // After 9:30pm, "12:40am" is tomorrow.
  assert.equal(Q.parseLimitReset(LIMIT_MSG("12:40am"), failedAt), tky(2026, 10, 28, 0, 40));
  assert.equal(Q.parseLimitReset(LIMIT_MSG("12pm"), tky(2026, 10, 27, 9, 0)), tky(2026, 10, 27, 12, 0));
  assert.equal(Q.parseLimitReset("API Error: 529 Overloaded", failedAt), null);
  assert.equal(Q.parseLimitReset("exit code 1: boom", failedAt), null);
});

test("a predecessor that dies on the usage limit holds the chain, then re-runs once and carries on", () => {
  const env = tempEnv();
  const a = randomUUID();
  writeTicket(env, a, "running");
  const b = queue(env, a);
  const c = queue(env, b.id, "devin");

  const failedAt = tky(2026, 10, 27, 21, 30);
  writeTicket(env, a, "failed", { errorMessage: LIMIT_MSG("10pm"), finishedAt: failedAt });
  let plan = Q.planSweep(env, failedAt + 1000);
  assert.deepEqual(plan.release, []);
  assert.deepEqual(plan.blocked, [], "a usage limit is not a failure");
  assert.deepEqual(plan.held.map((j) => j.id), [b.id]);
  assert.equal(stateOf(env, b.id), "held");
  assert.equal(stateOf(env, c.id), "waiting", "C waits on held B, it is not blocked");
  Q.markNotified(env, [b.id]);

  // Before the reset (plus grace): nothing.
  plan = Q.planSweep(env, tky(2026, 10, 27, 22, 1));
  assert.deepEqual(plan.rerun, []);

  // After: one re-run of A, and B waits on it.
  plan = Q.planSweep(env, tky(2026, 10, 27, 22, 3));
  assert.equal(plan.rerun.length, 1);
  assert.equal(plan.rerun[0].of, a);
  const rerunId = plan.rerun[0].id;
  const jobB = Q.listJobs(env).find((j) => j.id === b.id);
  assert.equal(jobB.state, "waiting");
  assert.equal(jobB.after, rerunId);
  assert.equal(jobB.limitReruns, 1);

  // The re-run's ticket isn't written yet: still pending, not "gone".
  assert.deepEqual(Q.planSweep(env, tky(2026, 10, 27, 22, 3)).blocked, []);
  writeTicket(env, rerunId, "done");
  assert.deepEqual(Q.planSweep(env).release.map((j) => j.id), [b.id]);
});

test("one re-run per dead job, however many wait on it; a third limit in a row stops the chain", () => {
  const env = tempEnv();
  const a = randomUUID();
  writeTicket(env, a, "running");
  const b1 = queue(env, a);
  const b2 = queue(env, a, "devin");
  const t0 = tky(2026, 10, 27, 21, 30);
  writeTicket(env, a, "failed", { errorMessage: LIMIT_MSG("10pm"), finishedAt: t0 });
  Q.planSweep(env, t0);
  let plan = Q.planSweep(env, tky(2026, 10, 27, 22, 5));
  assert.equal(plan.rerun.length, 1, "both waiters share one re-run");
  let rerun = plan.rerun[0].id;
  assert.ok(Q.listJobs(env).filter((j) => j.after === rerun).length === 2);

  // The re-run dies on the limit too: held again, second re-run.
  writeTicket(env, rerun, "failed", { errorMessage: LIMIT_MSG("3am"), finishedAt: tky(2026, 10, 27, 23, 0) });
  Q.planSweep(env, tky(2026, 10, 27, 23, 0));
  assert.equal(stateOf(env, b1.id), "held");
  plan = Q.planSweep(env, tky(2026, 10, 28, 3, 5));
  assert.equal(plan.rerun.length, 1);
  rerun = plan.rerun[0].id;

  // And again: the limit now counts as a failure.
  writeTicket(env, rerun, "failed", { errorMessage: LIMIT_MSG("8am"), finishedAt: tky(2026, 10, 28, 4, 0) });
  plan = Q.planSweep(env, tky(2026, 10, 28, 4, 0));
  assert.deepEqual(plan.blocked.map((j) => j.id).sort(), [b1.id, b2.id].sort());
  assert.match(plan.blocked[0].reason, /already re-ran it 2 times/);
});

test("a re-run that can't start blocks what waits on it; held jobs count toward the cap and can be cancelled", () => {
  const env = tempEnv();
  const a = randomUUID();
  writeTicket(env, a, "running");
  const b = queue(env, a);
  const t0 = tky(2026, 10, 27, 21, 30);
  writeTicket(env, a, "failed", { errorMessage: LIMIT_MSG("10pm"), finishedAt: t0 });
  Q.planSweep(env, t0);
  assert.equal(Q.listJobs(env).filter(Q.isActive).length, 1, "held is active");
  const plan = Q.planSweep(env, tky(2026, 10, 27, 22, 5));
  const hit = Q.blockWaitersOn(env, plan.rerun[0].id, "the re-run could not start: no agent");
  assert.deepEqual(hit.map((j) => j.id), [b.id]);
  assert.equal(stateOf(env, b.id), "blocked");

  const d = queue(env, a); // queueing behind a job that died on the limit is allowed
  assert.equal(Q.cancel(env, d.id).ok, true);
});

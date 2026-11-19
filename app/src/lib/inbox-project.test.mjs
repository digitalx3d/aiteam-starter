// Tests for reading an inbox post's project. Run from the app/ folder:
//   node --test src/lib/inbox-project.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveProject } from "./inbox-project.ts";

const FOLDERS = ["BakerySite", "BakerySite-1.3", "podcastLaunch", "GardenPlanner", "aiTeam", "Jev"];
const ALIASES = { bakerysite: ["bakery", "bakerys", "the bakery"], gardenplanner: ["garden"] };

const entry = (agent, title, project) => ({
  id: "x", from: agent.toLowerCase(), to: ["boss"], priority: "medium", timestamp: "2026-10-17",
  statedAt: null, agent, title, body: "", ...(project ? { project } : {}),
});
const resolve = (agent, title, project) => resolveProject(entry(agent, title, project), FOLDERS, ALIASES);

test("project after the agent's name moves to its own field", () => {
  assert.deepEqual(resolve("Devin podcastLaunch", "episode pages"), { project: "podcastLaunch", agent: "Devin", title: "episode pages" });
});

test("project in front of the title with a colon is taken off the title", () => {
  assert.deepEqual(resolve("Casey", "BakerySite: catering guide page"), { project: "BakerySite", agent: "Casey", title: "catering guide page" });
});

test("a brand that starts the sentence labels the post and stays in the title", () => {
  const r = resolve("CVB", "Bakery-Site 1.2 published to the web");
  assert.equal(r.project, "BakerySite");
  assert.equal(r.title, "Bakery-Site 1.2 published to the web");
});

test("the id line's project wins, spelled as the folder", () => {
  assert.equal(resolve("Devin", "Garden: thing", "gardenplanner").project, "GardenPlanner");
});

test("a release worktree counts as its repo", () => {
  assert.equal(resolve("Devin BakerySite-1.3", "batch").project, "BakerySite");
});

test("an urgent tag in front of the project is dropped from the title", () => {
  assert.deepEqual(resolve("Devin", "[HIGH] BakerySite, checkout takes no payment"), {
    project: "BakerySite", agent: "Devin", title: "checkout takes no payment",
  });
});

test("a project in brackets at the end of the title", () => {
  assert.deepEqual(resolve("Casey", "Opening-hours email (BakerySite)"), {
    project: "BakerySite", agent: "Casey", title: "Opening-hours email",
  });
});

test("a script's name can say its project and stays the sender", () => {
  assert.deepEqual(resolve("aiTeam config backup", "snapshot is 363 MB"), {
    project: "aiTeam", agent: "aiTeam config backup", title: "snapshot is 363 MB",
  });
});

test("no project named: none invented; short folder names never match words", () => {
  assert.equal(resolve("Indy", "Thursday digest").project, undefined);
  assert.equal(resolve("Devin", "Jev is not matched as a word").project, undefined);
});

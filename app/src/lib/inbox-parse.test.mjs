// Tests for the shared-inbox parser. Run from the app/ folder:
//   node --test src/lib/inbox-parse.test.mjs
// Node 22.18+ strips the TypeScript types on import, so no build step.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInbox, parseInboxDetailed, legacyIdRenames, isForOwner, ownerTokens } from "./inbox-parse.ts";

// The made-up owner every test here posts to.
const OWNER = ownerTokens("Boss Person");

const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);
const DOT = String.fromCharCode(0xb7);

/** What a Windows-1252 misread of UTF-8 text looks like, `times` over. */
const CP1252 = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020,
  0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152,
  0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022,
  0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a,
  0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};
function misread(text, times = 1) {
  let out = text;
  for (let i = 0; i < times; i++) {
    out = [...Buffer.from(out, "utf8")].map((b) => String.fromCharCode(CP1252[b] ?? b)).join("");
  }
  return out;
}

const meta = (id, sep = ` ${DOT} `) =>
  `> **id:** ${id}${sep}**from:** devin${sep}**to:** boss, cvb${sep}**priority:** high`;

const post = (id, title = "the thing") =>
  `## 2026-10-08 -- Devin: ${title}\n${meta(id)}\n\nBody of ${id}.\n`;

// --- separators ---------------------------------------------------------

test("a separator on line 1 of the file does not hide the first post", () => {
  const md = `---\n${post("2026-10-08T0700-indy-digest")}\n---\n${post("2026-10-07T1200-devin-b")}`;
  const ids = parseInbox(md).map((e) => e.id);
  assert.deepEqual(ids, ["2026-10-08T0700-indy-digest", "2026-10-07T1200-devin-b"]);
});

test("CRLF, a byte-order mark, padded separators and stray blank lines all parse", () => {
  const md =
    "\uFEFF\r\n\r\n---   \r\n\r\n" +
    post("2026-10-08T0700-a").replace(/\n/g, "\r\n") +
    "\r\n\r\n  ---\r\n\r\n\r\n" +
    post("2026-10-08T0800-b").replace(/\n/g, "\r\n");
  const entries = parseInbox(md);
  assert.deepEqual(entries.map((e) => e.id), ["2026-10-08T0700-a", "2026-10-08T0800-b"]);
  assert.equal(entries[0].body, "Body of 2026-10-08T0700-a.");
});

test("a separator glued to the next heading (---## ...) still splits the posts", () => {
  // Exactly what hid Indy's 2026-10-08 digest the second time.
  const md = `${post("2026-10-08T1550-ethan-retest")}\n\n\n---## 2026-10-08 -- Indy: Thursday digest\n${meta("2026-10-08T0700-indy-digest")}\n\nDigest.\n`;
  const { entries } = parseInboxDetailed(md);
  assert.deepEqual(entries.map((e) => e.id), ["2026-10-08T1550-ethan-retest", "2026-10-08T0700-indy-digest"]);
  assert.equal(entries[0].body, "Body of 2026-10-08T1550-ethan-retest.");
  assert.equal(entries[1].title, "Thursday digest");
});

test("posts appended with no separator between them are still separate posts", () => {
  const md =
    post("2026-10-06T1000-a") +
    "\n## 2026-10-06 | Casey | BakerySite: copy fix\n\nCasey body.\n" +
    "\n## 2026-10-07 | Devin | Reddit filter\n\n- Files: x\n";
  const entries = parseInbox(md);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].body, "Body of 2026-10-06T1000-a.");
  assert.equal(entries[1].agent, "Casey");
  assert.equal(entries[1].title, "BakerySite: copy fix");
  assert.equal(entries[2].agent, "Devin");
  assert.equal(entries[2].body, "- Files: x");
});

test("an undated ## subheading inside a body stays in the body", () => {
  const md = `## 2026-10-08 -- Devin: report\n${meta("2026-10-08T0900-d")}\n\nIntro.\n\n## Findings\n\nOne.\n`;
  const [e] = parseInbox(md);
  assert.equal(parseInbox(md).length, 1);
  assert.match(e.body, /## Findings\n\nOne\.$/);
});

test("a --- rule inside a body keeps the rest of the body", () => {
  const md = `${post("2026-10-08T0900-r")}\nMore text\n---\nAfter the rule.\n\n---\n${post("2026-10-07T0900-s")}`;
  const entries = parseInbox(md);
  assert.equal(entries.length, 2);
  // Blank line before the rule, so "More text" is not turned into a heading.
  assert.match(entries[0].body, /More text\n\n---\n\nAfter the rule\.$/);
});

// --- headings -------------------------------------------------------------

for (const [name, sep] of [
  ["em dash", EM],
  ["en dash", EN],
  ["single hyphen", "-"],
]) {
  test(`heading with ${name} instead of --`, () => {
    const md = `## 2026-10-08 ${sep} Ethan: review done\n${meta("2026-10-08T1000-e")}\n\nx\n`;
    const [e] = parseInbox(md);
    assert.equal(e.timestamp, "2026-10-08");
    assert.equal(e.agent, "Ethan");
    assert.equal(e.title, "review done");
    assert.equal(e.formatIssue, undefined);
  });
}

test("heading with no colon takes the agent from the id line", () => {
  const md = `## 2026-10-07 -- weekly janitor report\n${meta("2026-10-07T2120-devin-janitor")}\n\nx\n`;
  const [e] = parseInbox(md);
  assert.equal(e.agent, "Devin");
  assert.equal(e.title, "weekly janitor report");
});

test("heading with no colon and no id line takes the first word as the agent", () => {
  const [e] = parseInbox("## 2026-10-07 -- Devin weekly janitor\n\nx\n");
  assert.equal(e.agent, "Devin");
  assert.equal(e.title, "weekly janitor");
});

test("pipe-column heading", () => {
  const md = `## 2026-10-06 14:40 | Devin | BakerySite: screenshots\n${meta("2026-10-06T-devin-shots")}\n\nx\n`;
  const [e] = parseInbox(md);
  assert.equal(e.timestamp, "2026-10-06 14:40");
  assert.equal(e.agent, "Devin");
  assert.equal(e.title, "BakerySite: screenshots");
  // The id has no time, so the heading's time is used.
  assert.equal(e.statedAt, "2026-10-06T14:40:00");
});

test("heading with no separator after the date", () => {
  const [e] = parseInbox(`## 2026-10-06 Casey: privacy fix\n${meta("2026-10-06T1500-casey-p")}\n`);
  assert.equal(e.agent, "Casey");
  assert.equal(e.title, "privacy fix");
});

test("the documented heading still reads exactly as before, pipes in the title included", () => {
  const [e] = parseInbox(`## [HIGH] 2026-08-14 -- Ethan: A | B - C\n${meta("2026-08-14T2130-x")}\n`);
  assert.equal(e.timestamp, "[HIGH] 2026-08-14");
  assert.equal(e.agent, "Ethan");
  assert.equal(e.title, "A | B - C");
});

test("a heading that can't be read still shows, flagged, when the id line is fine", () => {
  const md = `---\n## Quick note from CVB\n${meta("2026-10-08T1100-cvb-note")}\n\nx\n`;
  const [e] = parseInbox(md);
  assert.equal(e.id, "2026-10-08T1100-cvb-note");
  assert.equal(e.title, "Quick note from CVB");
  assert.equal(e.agent, "Devin");
  assert.equal(e.timestamp, "2026-10-08");
  assert.ok(e.formatIssue);
});

// --- id lines ------------------------------------------------------------

test("id line separated by pipes", () => {
  const md = `## 2026-09-27 -- Maya: poller\n${meta("2026-09-27T0800-maya-p", " | ")}\n`;
  const [e] = parseInbox(md);
  assert.equal(e.id, "2026-09-27T0800-maya-p");
  assert.deepEqual(e.to, ["boss", "cvb"]);
  assert.equal(e.priority, "high");
  assert.deepEqual(e.legacyIds, ["2026-09-27T0800-maya-p |"]);
});

test("id line separated by spaced hyphens", () => {
  const [e] = parseInbox(`## 2026-09-01 -- Devin: x\n${meta("2026-09-01T-devin-round4b", " - ")}\n`);
  assert.equal(e.id, "2026-09-01T-devin-round4b");
  assert.equal(e.from, "devin");
  assert.deepEqual(e.to, ["boss", "cvb"]);
});

for (const times of [1, 2, 7]) {
  test(`id line with its dots misread ${times} time(s)`, () => {
    const sep = ` ${misread(DOT, times)} `;
    const [e] = parseInbox(`## 2026-08-12 -- Devin: pm2\n${meta("2026-08-12T1745-devin-pm2", sep)}\n`);
    assert.equal(e.id, "2026-08-12T1745-devin-pm2");
    assert.equal(e.from, "devin");
    assert.deepEqual(e.to, ["boss", "cvb"]);
    assert.equal(e.priority, "high");
  });
}

test("unbolded fields, no leading >, and **id**: all read", () => {
  const md =
    "## 2026-10-08 -- Indy: a\nid: 2026-10-08T0100-a · from: indy · to: boss · priority: low\n\n" +
    "---\n## 2026-10-08 -- Indy: b\n**id**: 2026-10-08T0200-b · **from**: indy\n";
  const [a, b] = parseInbox(md);
  assert.equal(a.id, "2026-10-08T0100-a");
  assert.equal(a.priority, "low");
  assert.deepEqual(a.to, ["boss"]);
  assert.equal(b.id, "2026-10-08T0200-b");
  assert.equal(b.from, "indy");
});

test("legacyIdRenames maps the old reading to the new id", () => {
  const md = `## 2026-09-21 -- Indy: d\n${meta("2026-09-21T0800-indy-d", ` ${misread(DOT, 2)} `)}\n`;
  const renames = legacyIdRenames(parseInbox(md));
  assert.deepEqual(Object.values(renames), ["2026-09-21T0800-indy-d"]);
  assert.notEqual(Object.keys(renames)[0], "2026-09-21T0800-indy-d");
});

// --- raw fallback ---------------------------------------------------------

test("a post with no id line is shown raw and flagged, not dropped", () => {
  const md = `${post("2026-10-08T0700-a")}\n---\n## 2026-10-07 -- janitor: would free 12.58 GB\n\njanitor: report at C:\\x.md\n`;
  const entries = parseInbox(md);
  assert.equal(entries.length, 2);
  const raw = entries[1];
  assert.match(raw.id, /^unparsed-[0-9a-f]{8}$/);
  assert.equal(raw.agent, "janitor");
  assert.equal(raw.title, "would free 12.58 GB");
  assert.equal(raw.body, "janitor: report at C:\\x.md");
  assert.deepEqual(raw.to, []);
  assert.ok(raw.formatIssue);
  // Same text, same id: read state sticks to it across reloads, and a post
  // appended after it (separator included) does not change it either.
  assert.equal(parseInbox(md)[1].id, raw.id);
  assert.equal(parseInbox(`${md}\n\n---\n${post("2026-10-06T0900-z")}`)[1].id, raw.id);
  assert.equal(parseInbox(`${md}\n## 2026-10-06 | Casey | appended\n\nx\n`)[1].id, raw.id);
});

test("[HIGH] tag sets priority when there is no id line to say otherwise", () => {
  const [e] = parseInbox("## [HIGH] 2026-10-08 -- Ethan: lock rule\n\nx\n");
  assert.equal(e.priority, "high");
});

test("an id line after a separator with no heading is its own post", () => {
  const md = `${post("2026-10-08T0700-a")}\n---\n${meta("2026-10-08T0800-headless")}\n\nNo heading here.\n`;
  const entries = parseInbox(md);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].id, "2026-10-08T0800-headless");
  assert.equal(entries[1].body, "No heading here.");
  assert.ok(entries[1].formatIssue);
});

test("text with no heading at the top of the file is shown, not dropped", () => {
  const md = `**Devin:** the build is green\n\nDetails.\n\n---\n${post("2026-10-08T0700-a")}`;
  const entries = parseInbox(md);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].title, "Devin:** the build is green");
  assert.ok(entries[0].formatIssue);
});

test("a post with no id line can't borrow one quoted further down its body", () => {
  const md = `## 2026-10-08 -- CVB: relay\n\nPara one.\n\nPara two.\n\nPara three.\n\n${meta("2026-10-01T0700-other")}\n`;
  const [e] = parseInbox(md);
  assert.match(e.id, /^unparsed-/);
});

// --- deliberate skips ----------------------------------------------------

test("the file's own header is skipped and does not swallow or pollute posts", () => {
  const md =
    `${post("2026-10-01T0700-indy-digest")}\n# Shared inbox -- team bulletin board\n\nCross-team channel.\n---\n` +
    `Orphan line after the header.\n\n---\n${post("2026-09-28T0800-indy-digest")}`;
  const { entries, skipped } = parseInboxDetailed(md);
  assert.equal(entries[0].body, "Body of 2026-10-01T0700-indy-digest.");
  assert.deepEqual(skipped.map((s) => s.reason), ["file-header"]);
  assert.equal(skipped[0].line, 6);
  // Text after the header's separator is not part of the header.
  assert.equal(entries[1].title, "Orphan line after the header.");
  assert.equal(entries[2].id, "2026-09-28T0800-indy-digest");
});

test("schema templates are skipped", () => {
  const md =
    "```\n## <timestamp> -- <agent>: <title>\n> **id:** <YYYY-MM-DDTHHMM>-<from>-<slug> · **from:** <from>\n```\n\n---\n" +
    "## <timestamp> -- <agent>: <title>\n\n<body>\n\n---\n" +
    post("2026-10-08T0700-a");
  const { entries, skipped } = parseInboxDetailed(md);
  assert.deepEqual(entries.map((e) => e.id), ["2026-10-08T0700-a"]);
  assert.deepEqual(skipped.map((s) => s.reason), ["template", "template"]);
});

test("a literal repost is deduped; a reused id on a different post is kept", () => {
  const md = [post("2026-10-08T0700-x", "one"), post("2026-10-08T0700-x", "one"), post("2026-10-08T0700-x", "two")].join("\n---\n");
  const { entries, skipped } = parseInboxDetailed(md);
  assert.deepEqual(entries.map((e) => e.id), ["2026-10-08T0700-x", "2026-10-08T0700-x~2"]);
  assert.deepEqual(skipped.map((s) => s.reason), ["duplicate"]);
});

test("a dot-column heading reads its agent and title", () => {
  const [e] = parseInbox(`## 2026-10-14 ${DOT} Casey ${DOT} BakerySite: menu page words

x
`);
  assert.equal(e.agent, "Casey");
  assert.equal(e.title, "BakerySite: menu page words");
});

// --- who the Inbox is for -------------------------------------------------

test("isForOwner: addressed posts show only when they name the owner or everyone", () => {
  const withTo = (to) => `## 2026-10-08 -- Devin: t
> **id:** 2026-10-08T0700-devin-t ${DOT} **from:** devin ${DOT} **to:** ${to} ${DOT} **priority:** medium

x
`;
  assert.equal(isForOwner(parseInbox(withTo("boss, cvb"))[0], OWNER), true);
  assert.equal(isForOwner(parseInbox(withTo("all"))[0], OWNER), true);
  assert.equal(isForOwner(parseInbox(withTo("cvb"))[0], OWNER), false);
  assert.equal(isForOwner(parseInbox(withTo("maya, cvb"))[0], OWNER), false);
  assert.equal(isForOwner(parseInbox(withTo("owner"))[0]), true);
  assert.equal(isForOwner(parseInbox(withTo("boss-person"))[0], OWNER), true);
  assert.equal(isForOwner(parseInbox(withTo("someone-else"))[0], OWNER), false);
});

test("isForOwner: unaddressed posts show from CVB and scripts, not from workers", () => {
  const raw = (heading) => parseInbox(`## ${heading}

x
`)[0];
  assert.equal(isForOwner(raw("2026-10-16 -- CVB: release deployed")), true);
  assert.equal(isForOwner(raw("2026-10-11 -- janitor: would free 12 GB")), true);
  assert.equal(isForOwner(raw("[WARNING] 2026-10-17 -- aiTeam config backup: big")), true);
  assert.equal(isForOwner(raw("2026-10-15 -- Devin: guide pages built")), false);
  assert.equal(isForOwner(raw("2026-10-14 -- Devin BakerySite: menu pages")), false);
  assert.equal(isForOwner(raw(`2026-10-14 ${DOT} Casey ${DOT} BakerySite: words`)), false);
  // A worker's urgent post still reaches the owner.
  assert.equal(isForOwner(raw("2026-10-14 -- Devin: [HIGH] checkout takes no payment")), true);
  assert.equal(isForOwner(raw("[HIGH] 2026-10-14 -- Devin: checkout takes no payment")), true);
});

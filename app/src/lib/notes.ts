import path from "node:path";
import { promises as fsp } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolveProjectCwd } from "./projects";

// Stripped-down Google Keep: one file per note under .aiteam/notes/<id>.md.
// Each note is title + free-text body + at most one attached image. No
// checkboxes, colors, tags, pin, archive, or sharing — those can be added
// later if there's a real need (2026-07-09 decision).

export interface Note {
  id: string;
  title: string;
  body: string;
  /** Filename only (e.g. "20260709-153000-abc123.png"), relative to
   *  <projectCwd>/note-images/. Null when the note has no image. */
  image: string | null;
  created: string;
  updated: string;
}

function notesDirFor(projectCwd: string): string {
  return path.join(projectCwd, ".aiteam", "notes");
}

function noteImagesDirFor(projectCwd: string): string {
  return path.join(projectCwd, "note-images");
}

async function ensureNotesDir(projectCwd: string): Promise<string> {
  const dir = notesDirFor(projectCwd);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

function isoDate(d: Date = new Date()): string {
  return d.toISOString();
}

/** Trivial flat-key YAML parser. Strings (quoted or bare), `null`. Mirrors tasks.ts. */
function parseFrontmatter(raw: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (value === "" || value === "null" || value === "~") {
      out[key] = null;
      continue;
    }
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function stringifyFrontmatter(data: Record<string, string | null>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined) {
      lines.push(`${k}: null`);
      continue;
    }
    const needsQuote =
      /[:#&*?{}\[\]|>!%@`,]/.test(v) ||
      /^\s|\s$/.test(v) ||
      /^(true|false|null|yes|no|~)$/i.test(v);
    if (needsQuote) {
      lines.push(`${k}: "${v.replace(/"/g, '\\"')}"`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  return lines.join("\n");
}

function splitFrontmatter(content: string): {
  meta: Record<string, string | null>;
  body: string;
} {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: content };
  return { meta: parseFrontmatter(m[1]), body: m[2].trimStart() };
}

function buildNoteFile(note: Note): string {
  const meta: Record<string, string | null> = {
    id: note.id,
    title: note.title,
    image: note.image,
    created: note.created,
    updated: note.updated,
  };
  return `---\n${stringifyFrontmatter(meta)}\n---\n\n${note.body ?? ""}\n`;
}

function parseNoteFile(content: string, fallbackId: string): Note {
  const { meta, body } = splitFrontmatter(content);
  const created = meta.created ?? isoDate();
  return {
    id: meta.id ?? fallbackId,
    title: meta.title ?? "",
    body: body.trim(),
    image: meta.image ?? null,
    created,
    updated: meta.updated ?? created,
  };
}

function noteFilePath(projectCwd: string, id: string): string {
  return path.join(notesDirFor(projectCwd), `${id}.md`);
}

/** Best-effort delete of a note's attached image. Never throws. */
async function unlinkImageIfAny(projectCwd: string, image: string | null): Promise<void> {
  if (!image) return;
  try {
    await fsp.unlink(path.join(noteImagesDirFor(projectCwd), image));
  } catch {
    /* already gone, or never existed — fine */
  }
}

export async function listNotes(slug: string): Promise<Note[]> {
  const cwd = resolveProjectCwd(slug);
  if (!cwd) return [];
  const dir = notesDirFor(cwd);
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const notes: Note[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const full = path.join(dir, name);
    try {
      const raw = await fsp.readFile(full, "utf8");
      notes.push(parseNoteFile(raw, name.replace(/\.md$/, "")));
    } catch {
      /* skip unreadable */
    }
  }
  // Newest-edited-first, matching Keep's default ordering. No manual reorder (yet).
  notes.sort((a, b) => b.updated.localeCompare(a.updated));
  return notes;
}

export interface CreateNoteInput {
  title?: string;
  body?: string;
  image?: string | null;
}

export async function createNote(
  slug: string,
  input: CreateNoteInput
): Promise<Note | null> {
  const cwd = resolveProjectCwd(slug);
  if (!cwd) return null;
  await ensureNotesDir(cwd);

  const now = isoDate();
  const id = `n-${randomUUID().slice(0, 8)}`;
  const note: Note = {
    id,
    title: (input.title ?? "").trim(),
    body: (input.body ?? "").trim(),
    image: input.image ?? null,
    created: now,
    updated: now,
  };
  await fsp.writeFile(noteFilePath(cwd, id), buildNoteFile(note), "utf8");
  return note;
}

export interface UpdateNoteInput {
  title?: string;
  body?: string;
  /** Pass null to remove the image, undefined to leave it unchanged. */
  image?: string | null;
}

export async function updateNote(
  slug: string,
  id: string,
  input: UpdateNoteInput
): Promise<Note | null> {
  const cwd = resolveProjectCwd(slug);
  if (!cwd) return null;
  const file = noteFilePath(cwd, id);
  let existing: Note;
  try {
    existing = parseNoteFile(await fsp.readFile(file, "utf8"), id);
  } catch {
    return null;
  }

  const imageChanged = input.image !== undefined && input.image !== existing.image;
  const next: Note = {
    ...existing,
    title: input.title !== undefined ? input.title.trim() : existing.title,
    body: input.body !== undefined ? input.body.trim() : existing.body,
    image: input.image !== undefined ? input.image : existing.image,
    updated: isoDate(),
  };
  await fsp.writeFile(file, buildNoteFile(next), "utf8");
  if (imageChanged) await unlinkImageIfAny(cwd, existing.image);
  return next;
}

export async function deleteNote(slug: string, id: string): Promise<boolean> {
  const cwd = resolveProjectCwd(slug);
  if (!cwd) return false;
  const file = noteFilePath(cwd, id);
  let existing: Note | null = null;
  try {
    existing = parseNoteFile(await fsp.readFile(file, "utf8"), id);
  } catch {
    return false;
  }
  try {
    await fsp.unlink(file);
  } catch {
    return false;
  }
  await unlinkImageIfAny(cwd, existing.image);
  return true;
}

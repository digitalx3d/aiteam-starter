"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Plus, Trash2, X, ImagePlus, Loader2, Pencil, Eye } from "lucide-react";

export interface Note {
  id: string;
  title: string;
  body: string;
  image: string | null;
  created: string;
  updated: string;
}

interface NotesBoardProps {
  slug: string;
  initialNotes: Note[];
}

function imageUrl(slug: string, image: string): string {
  return `/api/files/${encodeURIComponent(slug)}/note-images/${encodeURIComponent(image)}`;
}

async function uploadImage(
  slug: string,
  file: File
): Promise<{ image: string } | { error: string }> {
  const form = new FormData();
  form.append("project", slug);
  form.append("kind", "note-images");
  form.append("file", file, file.name);
  try {
    const res = await fetch("/api/upload", { method: "POST", body: form });
    const data = (await res.json()) as {
      ok?: boolean;
      files?: Array<{ url: string }>;
      error?: string;
    };
    if (!res.ok || !data.ok || !data.files?.[0]) {
      return { error: data.error || `Upload failed (${res.status})` };
    }
    const filename = decodeURIComponent(data.files[0].url.split("/").pop() || "");
    if (!filename) return { error: "Upload succeeded but returned no filename" };
    return { image: filename };
  } catch (err) {
    return { error: (err as Error).message || "Upload failed" };
  }
}

// ---------------- Pasted-table detection ----------------
// Copying cells out of Excel/Sheets/etc. puts tab-separated rows on the
// clipboard as plain text. A plain textarea just dumps that as one long
// wrapped line per row — unreadable for anything wider than a couple of
// columns. Detect that shape on paste and convert it to a markdown table
// instead, which NoteMarkdown then renders as a real <table>.

function looksTabular(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return false;
  const tabCounts = lines.map((l) => (l.match(/\t/g) || []).length);
  if (tabCounts.some((c) => c === 0)) return false;
  return tabCounts.every((c) => c === tabCounts[0]);
}

function tsvToMarkdownTable(text: string): string {
  const rows = text
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
    .map((l) => l.split("\t"));
  const colCount = rows[0].length;
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r/g, "").trim();
  const rowLine = (cells: string[]) => {
    const padded = [...cells];
    while (padded.length < colCount) padded.push("");
    return `| ${padded.slice(0, colCount).map(esc).join(" | ")} |`;
  };
  const header = rowLine(rows[0]);
  const sep = `| ${rows[0].map(() => "---").join(" | ")} |`;
  const body = rows.slice(1).map(rowLine);
  return [header, sep, ...body].join("\n");
}

/** Shared paste handling for a note body textarea: images upload as the
 *  note's attached image; tabular plain text becomes a markdown table
 *  inserted at the cursor; anything else falls through to normal paste. */
function useBodyPaste(
  body: string,
  setBody: (v: string) => void,
  doUploadImage: (file: File) => void
) {
  return useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (items) {
        for (const item of Array.from(items)) {
          if (item.kind === "file") {
            const f = item.getAsFile();
            if (f && f.type.startsWith("image/")) {
              e.preventDefault();
              doUploadImage(f);
              return;
            }
          }
        }
      }
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (looksTabular(text)) {
        e.preventDefault();
        const table = tsvToMarkdownTable(text);
        const target = e.currentTarget;
        const start = target.selectionStart;
        const end = target.selectionEnd;
        const next = body.slice(0, start) + table + body.slice(end);
        setBody(next);
        requestAnimationFrame(() => {
          target.selectionStart = target.selectionEnd = start + table.length;
          target.focus();
        });
      }
      // else: default paste behavior (plain text) proceeds untouched.
    },
    [body, setBody, doUploadImage]
  );
}

// ---------------- Markdown rendering ----------------

const noteMarkdownComponents: Components = {
  p: ({ ...props }) => <p className="my-1.5 leading-relaxed" {...props} />,
  ul: ({ ...props }) => <ul className="list-disc pl-5 my-1.5 space-y-0.5" {...props} />,
  ol: ({ ...props }) => <ol className="list-decimal pl-5 my-1.5 space-y-0.5" {...props} />,
  li: ({ ...props }) => <li className="leading-relaxed" {...props} />,
  a: ({ ...props }) => (
    <a
      className="text-accent underline underline-offset-2 hover:opacity-80 break-all"
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      {...props}
    />
  ),
  strong: ({ ...props }) => <strong className="font-semibold" {...props} />,
  em: ({ ...props }) => <em className="italic" {...props} />,
  code: ({ className, ...props }) => (
    <code
      className={`${className ?? ""} px-1 py-0.5 rounded bg-tool-bg border border-tool-border text-xs font-mono`}
      {...props}
    />
  ),
  table: ({ ...props }) => (
    <div className="my-2 overflow-x-auto">
      <table className="border-collapse text-xs" {...props} />
    </div>
  ),
  th: ({ ...props }) => (
    <th className="border border-border px-2 py-1 text-left font-medium bg-muted-bg" {...props} />
  ),
  td: ({ ...props }) => <td className="border border-border px-2 py-1 align-top" {...props} />,
};

function NoteMarkdown({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="text-sm text-foreground/85 [&_*]:max-w-full">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={noteMarkdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

// ---------------- Board ----------------

export function NotesBoard({ slug, initialNotes }: NotesBoardProps) {
  const [notes, setNotes] = useState<Note[]>(initialNotes);
  const [composerOpen, setComposerOpen] = useState(false);
  const [openNoteId, setOpenNoteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apiBase = `/api/projects/${encodeURIComponent(slug)}/notes`;

  const createNote = useCallback(
    async (input: { title: string; body: string; image: string | null }) => {
      if (!input.title.trim() && !input.body.trim() && !input.image) {
        setComposerOpen(false);
        return;
      }
      try {
        const res = await fetch(apiBase, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const { note } = (await res.json()) as { note: Note };
        setNotes((prev) => [note, ...prev]);
        setComposerOpen(false);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [apiBase]
  );

  const updateNote = useCallback(
    async (id: string, patch: Partial<Pick<Note, "title" | "body" | "image">>) => {
      try {
        const res = await fetch(`${apiBase}/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { note } = (await res.json()) as { note: Note };
        setNotes((prev) =>
          [...prev.map((n) => (n.id === id ? note : n))].sort((a, b) =>
            b.updated.localeCompare(a.updated)
          )
        );
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [apiBase]
  );

  const deleteNote = useCallback(
    async (id: string) => {
      const before = notes;
      setNotes((prev) => prev.filter((n) => n.id !== id));
      setOpenNoteId((cur) => (cur === id ? null : cur));
      try {
        const res = await fetch(`${apiBase}/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (e) {
        setError((e as Error).message);
        setNotes(before);
      }
    },
    [apiBase, notes]
  );

  const openNote = notes.find((n) => n.id === openNoteId) ?? null;

  return (
    <div className="px-4 sm:px-6 py-4 max-w-6xl mx-auto">
      {error && (
        <div className="mb-3 rounded-md border border-error/40 bg-error-bg px-3 py-2 text-xs text-error flex items-start justify-between gap-2">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-error/70 hover:text-error"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      <div className="mb-5 max-w-xl">
        {composerOpen ? (
          <NoteComposer
            slug={slug}
            onCancel={() => setComposerOpen(false)}
            onCreate={createNote}
          />
        ) : (
          <button
            type="button"
            onClick={() => setComposerOpen(true)}
            className="w-full flex items-center gap-2 rounded-lg border border-border bg-cards-bg px-4 py-2.5 text-sm text-muted hover:border-foreground/30 hover:text-foreground/80"
          >
            <Plus className="h-4 w-4" />
            <span>Take a note...</span>
          </button>
        )}
      </div>

      {notes.length === 0 && !composerOpen ? (
        <div className="text-sm text-muted/70 italic px-1 py-8 text-center">
          No notes yet.
        </div>
      ) : (
        <div className="columns-1 sm:columns-2 lg:columns-3 xl:columns-4 gap-4 [column-fill:_balance]">
          {notes.map((note) => (
            <div key={note.id} className="break-inside-avoid mb-4">
              <NoteCardPreview
                slug={slug}
                note={note}
                onOpen={() => setOpenNoteId(note.id)}
                onDelete={() => {
                  if (confirm("Delete this note? This can't be undone.")) deleteNote(note.id);
                }}
              />
            </div>
          ))}
        </div>
      )}

      {openNote && (
        <NoteModal
          slug={slug}
          note={openNote}
          onClose={() => setOpenNoteId(null)}
          onUpdate={(patch) => updateNote(openNote.id, patch)}
          onDelete={() => deleteNote(openNote.id)}
        />
      )}
    </div>
  );
}

function ImageAttachArea({
  slug,
  onImageChange,
  onUploadError,
}: {
  slug: string;
  onImageChange: (image: string | null) => void;
  onUploadError: (msg: string) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const doUpload = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("image/")) return;
      setUploading(true);
      const result = await uploadImage(slug, file);
      setUploading(false);
      if ("error" in result) {
        onUploadError(result.error);
        return;
      }
      onImageChange(result.image);
    },
    [slug, onImageChange, onUploadError]
  );

  return { uploading, doUpload, fileInputRef } as const;
}

function ImagePreview({
  slug,
  image,
  onRemove,
}: {
  slug: string;
  image: string;
  onRemove: () => void;
}) {
  return (
    <div className="relative mb-2 rounded-md overflow-hidden border border-border">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={imageUrl(slug, image)}
        alt=""
        className="w-full max-h-72 object-contain bg-tool-bg"
      />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="absolute top-1.5 right-1.5 rounded-full bg-background/90 p-1 text-muted hover:text-error shadow"
        title="Remove image"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function ImageButton({
  uploading,
  fileInputRef,
  onFile,
}: {
  uploading: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFile: (file: File) => void;
}) {
  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading}
        className="text-muted hover:text-foreground p-1"
        title="Attach image (also accepts paste)"
      >
        {uploading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <ImagePlus className="h-4 w-4" />
        )}
      </button>
    </>
  );
}

function NoteComposer({
  slug,
  onCancel,
  onCreate,
}: {
  slug: string;
  onCancel: () => void;
  onCreate: (input: { title: string; body: string; image: string | null }) => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const { uploading, doUpload, fileInputRef } = ImageAttachArea({
    slug,
    onImageChange: setImage,
    onUploadError: setUploadError,
  });
  const onPaste = useBodyPaste(body, setBody, doUpload);

  function commit() {
    onCreate({ title, body, image });
    setTitle("");
    setBody("");
    setImage(null);
    setUploadError(null);
  }

  return (
    <div className="rounded-lg border border-accent/40 bg-cards-bg p-3 space-y-2 shadow-sm">
      <input
        type="text"
        autoFocus
        placeholder="Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="w-full bg-transparent text-sm font-medium focus:outline-none placeholder:text-muted"
      />
      {image && (
        <ImagePreview slug={slug} image={image} onRemove={() => setImage(null)} />
      )}
      <textarea
        rows={3}
        placeholder="Take a note... (paste a spreadsheet selection to get a table)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onPaste={onPaste}
        className="w-full resize-none bg-transparent text-sm font-mono focus:outline-none placeholder:text-muted placeholder:font-sans"
      />
      {uploadError && <div className="text-xs text-error">{uploadError}</div>}
      <div className="flex items-center justify-between pt-1">
        <ImageButton uploading={uploading} fileInputRef={fileInputRef} onFile={doUpload} />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-xs rounded-md border border-border text-muted hover:text-foreground hover:border-foreground/30"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={commit}
            className="px-3 py-1.5 text-xs rounded-md bg-accent text-accent-fg font-medium hover:opacity-90"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/** Compact, read-only card shown in the masonry grid. Clamped height so a
 *  long note (or a big pasted table) doesn't blow out the grid — click
 *  anywhere to open the full note in a modal. */
function NoteCardPreview({
  slug,
  note,
  onOpen,
  onDelete,
}: {
  slug: string;
  note: Note;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const isEmpty = !note.title && !note.body && !note.image;
  return (
    <div
      onClick={onOpen}
      className="rounded-lg border border-border bg-cards-bg p-3 cursor-pointer hover:border-foreground/30 group relative"
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="absolute top-2 right-2 text-muted hover:text-error p-1 opacity-0 group-hover:opacity-100 transition-opacity z-10"
        title="Delete note"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
      {note.image && (
        <div className="-m-3 mb-2 rounded-t-lg overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageUrl(slug, note.image)} alt="" className="w-full object-cover max-h-40" />
        </div>
      )}
      {note.title && (
        <div className="text-sm font-medium mb-1 pr-5 break-words">{note.title}</div>
      )}
      {note.body && (
        <div className="max-h-56 overflow-hidden relative">
          <NoteMarkdown text={note.body} />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-cards-bg to-transparent" />
        </div>
      )}
      {isEmpty && <div className="text-sm text-muted italic">Empty note</div>}
    </div>
  );
}

/** Full-size popup for reading or editing a note. Opens in read view (full
 *  markdown rendering, comfortable for long content/tables); the pencil
 *  icon switches to a raw-text editor for title/body/image. Closing (X,
 *  backdrop click, or Escape) commits any edit-mode changes. */
function NoteModal({
  slug,
  note,
  onClose,
  onUpdate,
  onDelete,
}: {
  slug: string;
  note: Note;
  onClose: () => void;
  onUpdate: (patch: Partial<Pick<Note, "title" | "body" | "image">>) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [image, setImage] = useState<string | null>(note.image);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const { uploading, doUpload, fileInputRef } = ImageAttachArea({
    slug,
    onImageChange: setImage,
    onUploadError: setUploadError,
  });
  const onPaste = useBodyPaste(body, setBody, doUpload);

  const commit = useCallback(() => {
    const patch: Partial<Pick<Note, "title" | "body" | "image">> = {};
    if (title !== note.title) patch.title = title;
    if (body !== note.body) patch.body = body;
    if (image !== note.image) patch.image = image;
    if (Object.keys(patch).length > 0) onUpdate(patch);
  }, [title, body, image, note, onUpdate]);

  const closeAndCommit = useCallback(() => {
    if (editing) commit();
    onClose();
  }, [editing, commit, onClose]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeAndCommit();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [closeAndCommit]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={closeAndCommit}
    >
      <div
        className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-lg border border-border bg-cards-bg shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/60 shrink-0">
          {editing ? (
            <input
              type="text"
              autoFocus={!note.title}
              placeholder="Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="flex-1 bg-transparent text-sm font-semibold focus:outline-none placeholder:text-muted placeholder:font-normal"
            />
          ) : (
            <div className="flex-1 text-sm font-semibold truncate">
              {note.title || <span className="text-muted italic font-normal">Untitled note</span>}
            </div>
          )}
          <button
            type="button"
            onClick={() => {
              if (editing) commit();
              else {
                setTitle(note.title);
                setBody(note.body);
                setImage(note.image);
              }
              setEditing((v) => !v);
            }}
            className="text-muted hover:text-foreground p-1.5"
            title={editing ? "Done editing" : "Edit"}
          >
            {editing ? <Eye className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={() => {
              if (confirm("Delete this note? This can't be undone.")) onDelete();
            }}
            className="text-muted hover:text-error p-1.5"
            title="Delete note"
          >
            <Trash2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={closeAndCommit}
            className="text-muted hover:text-foreground p-1.5"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {editing ? (
            <>
              {image && (
                <ImagePreview slug={slug} image={image} onRemove={() => setImage(null)} />
              )}
              <textarea
                rows={16}
                autoFocus={!!note.title}
                placeholder="Note... (paste a spreadsheet selection to get a table)"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                onPaste={onPaste}
                className="w-full resize-none bg-transparent text-sm font-mono focus:outline-none placeholder:text-muted placeholder:font-sans leading-relaxed"
              />
              {uploadError && <div className="text-xs text-error mt-1">{uploadError}</div>}
            </>
          ) : (
            <>
              {note.image && (
                <div className="-mx-4 -mt-3 mb-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={imageUrl(slug, note.image)} alt="" className="w-full object-contain max-h-[50vh] bg-tool-bg" />
                </div>
              )}
              {note.body ? (
                <NoteMarkdown text={note.body} />
              ) : (
                <div className="text-sm text-muted italic">Empty note. Click the pencil to add content.</div>
              )}
            </>
          )}
        </div>

        {editing && (
          <div className="flex items-center justify-between px-4 py-2.5 border-t border-border/60 shrink-0">
            <ImageButton uploading={uploading} fileInputRef={fileInputRef} onFile={doUpload} />
            <button
              type="button"
              onClick={() => {
                commit();
                setEditing(false);
              }}
              className="px-3 py-1.5 text-xs rounded-md bg-accent text-accent-fg font-medium hover:opacity-90"
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

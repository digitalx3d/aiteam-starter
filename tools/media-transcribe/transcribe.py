"""Transcribe audio/video from YouTube, Google Drive, local file, or arbitrary URL.

Source types auto-detected from the input string:
  * local path             - decoded in place via PyAV/faster-whisper
  * youtube.com / youtu.be - yt-dlp: captions preferred, Whisper fallback
  * drive.google.com / bare Drive file id - gdown (must be public/anyone-with-link)
  * other http(s) URL      - yt-dlp first (it handles ~hundreds of sites), then direct download

Whisper runs on CUDA via faster-whisper. Audio decoding goes through PyAV, so the
ffmpeg CLI isn't required.

Output (JSON on stdout, or to --out file): {
  source_type, source, title, duration_s, language, model,
  segment_count, segments[{start,end,text}], text
}

Captions vs. Whisper:
  - For YouTube, the script tries captions first (manual, then auto). Captions are
    free and instant; Whisper takes ~3-8 min for a 30 min video on an RTX 4070 SUPER.
  - For everything else, Whisper is the only option.
  - --force-whisper bypasses captions and always runs Whisper.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Optional

# ─── CUDA DLL path bootstrap ──────────────────────────────────────────────────
# faster-whisper -> ctranslate2 loads cuBLAS/cuDNN via the OS loader, which on
# Windows reads PATH (not Python's add_dll_directory list). Both have to be set
# for the load to succeed, so we do both belt-and-suspenders.
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    for sp in (p for p in sys.path if "site-packages" in p):
        for sub in ("nvidia/cudnn/bin", "nvidia/cublas/bin", "nvidia/cuda_nvrtc/bin"):
            d = Path(sp) / sub
            if d.is_dir():
                try:
                    os.add_dll_directory(str(d))
                except Exception:
                    pass
                os.environ["PATH"] = str(d) + os.pathsep + os.environ.get("PATH", "")


# ─── Source classification ────────────────────────────────────────────────────

_YOUTUBE_RE = re.compile(r"(?:youtube\.com/|youtu\.be/)", re.I)
_DRIVE_RE = re.compile(r"drive\.google\.com.*?/(?:file/d/|open\?id=|uc\?id=)?([a-zA-Z0-9_-]{20,})", re.I)
_BARE_DRIVE_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{25,60}$")


def classify(source: str) -> tuple[str, str]:
    """Returns (source_type, normalized) where source_type is one of
    'local' | 'youtube' | 'drive' | 'http'."""
    p = Path(source)
    if p.exists():
        return "local", str(p.resolve())
    if _YOUTUBE_RE.search(source):
        return "youtube", source
    m = _DRIVE_RE.search(source)
    if m:
        return "drive", m.group(1)
    if _BARE_DRIVE_ID_RE.fullmatch(source):
        return "drive", source
    if re.match(r"^https?://", source, re.I):
        return "http", source
    raise SystemExit(
        f"could not classify input: {source!r}. "
        "Expected a local path, YouTube URL, Google Drive URL/ID, or http(s) URL."
    )


# ─── YouTube caption fetcher (reused logic from youtube-transcribe) ───────────

def _vtt_to_segments(vtt_text: str) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    ts_re = re.compile(r"(\d{2}:\d{2}:\d{2}\.\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}\.\d{3})")
    tag_re = re.compile(r"<[^>]+>")

    def to_sec(t: str) -> float:
        h, m, s = t.split(":")
        return int(h) * 3600 + int(m) * 60 + float(s)

    seen: set[str] = set()
    cur_start: float | None = None
    cur_end: float | None = None
    cur_lines: list[str] = []
    for raw in vtt_text.splitlines():
        line = raw.rstrip()
        m = ts_re.search(line)
        if m:
            if cur_start is not None and cur_lines:
                txt = " ".join(cur_lines).strip()
                if txt and txt not in seen:
                    seen.add(txt)
                    segments.append({"start": cur_start, "end": cur_end, "text": txt})
            cur_start, cur_end = to_sec(m.group(1)), to_sec(m.group(2))
            cur_lines = []
        elif line and cur_start is not None and not line.startswith(("WEBVTT", "Kind:", "Language:", "NOTE")):
            cleaned = tag_re.sub("", line).strip()
            if cleaned:
                cur_lines.append(cleaned)
    if cur_start is not None and cur_lines:
        txt = " ".join(cur_lines).strip()
        if txt and txt not in seen:
            segments.append({"start": cur_start, "end": cur_end, "text": txt})
    return segments


def youtube_captions(url: str, lang: str) -> tuple[dict, Optional[list[dict]], bool]:
    """Returns (info, segments_or_none, is_auto)."""
    import yt_dlp  # type: ignore

    with yt_dlp.YoutubeDL({"skip_download": True, "quiet": True, "no_warnings": True}) as ydl:
        info = ydl.extract_info(url, download=False)

    cap_url: Optional[str] = None
    is_auto = False
    for key, auto in (("subtitles", False), ("automatic_captions", True)):
        tracks = info.get(key) or {}
        if lang in tracks:
            for entry in tracks[lang]:
                if entry.get("ext") in ("vtt", "srv3", "srt", "json3"):
                    cap_url, is_auto = entry["url"], auto
                    break
            if cap_url:
                break

    if not cap_url:
        return info, None, False

    import urllib.request
    with urllib.request.urlopen(cap_url) as r:
        body = r.read().decode("utf-8", errors="replace")

    if "WEBVTT" in body[:200] or "-->" in body:
        segs = _vtt_to_segments(body)
    else:
        try:
            data = json.loads(body)
            segs = []
            for ev in data.get("events", []):
                start = ev.get("tStartMs", 0) / 1000.0
                dur = ev.get("dDurationMs", 0) / 1000.0
                txt = "".join(s.get("utf8", "") for s in (ev.get("segs") or []))
                txt = txt.replace("\n", " ").strip()
                if txt:
                    segs.append({"start": start, "end": start + dur, "text": txt})
        except Exception:
            segs = []
    return info, (segs or None), is_auto


# ─── Downloaders ──────────────────────────────────────────────────────────────

def download_youtube(url: str, dest_dir: Path) -> tuple[dict, Path]:
    """yt-dlp download to wav."""
    import yt_dlp  # type: ignore

    out_tpl = str(dest_dir / "%(id)s.%(ext)s")
    opts = {
        "format": "bestaudio/best",
        "outtmpl": out_tpl,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "postprocessors": [
            {"key": "FFmpegExtractAudio", "preferredcodec": "wav", "preferredquality": "0"}
        ],
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
    audio = dest_dir / f"{info['id']}.wav"
    if not audio.exists():
        cands = list(dest_dir.glob(f"{info['id']}.*"))
        if not cands:
            raise FileNotFoundError("yt-dlp produced no audio file")
        audio = cands[0]
    return info, audio


def download_drive(file_id: str, dest_dir: Path) -> tuple[dict, Path]:
    """gdown download. Requires public 'Anyone with the link' share or the file
    will fail to retrieve."""
    try:
        import gdown  # type: ignore
    except ImportError:
        raise SystemExit(
            "gdown is not installed. Run: pip install --user gdown\n"
            "Or download the Drive file manually and pass its local path instead."
        )

    out_path = dest_dir / f"{file_id}"
    print(f"[download] Google Drive id={file_id}", flush=True)
    try:
        result = gdown.download(id=file_id, output=str(out_path), quiet=True)
    except Exception as e:
        raise SystemExit(f"gdown failed: {e}\nIs the file shared as 'Anyone with the link'?")
    if not result:
        raise SystemExit(
            "Drive download returned no file. The link is probably not public.\n"
            "Either set Drive permissions to 'Anyone with the link', or download "
            "manually and re-run with the local file path."
        )
    final = Path(result)
    info = {
        "id": file_id,
        "title": final.name,
        "webpage_url": f"https://drive.google.com/file/d/{file_id}/view",
        "duration": None,
    }
    return info, final


def download_http(url: str, dest_dir: Path) -> tuple[dict, Path]:
    """Try yt-dlp first (handles many non-YouTube sites), then direct urllib."""
    try:
        return download_youtube(url, dest_dir)  # yt-dlp handles many sites
    except Exception:
        pass

    import urllib.request, urllib.parse
    name = Path(urllib.parse.urlparse(url).path).name or "download.bin"
    target = dest_dir / name
    print(f"[download] {url}", flush=True)
    urllib.request.urlretrieve(url, target)
    info = {"id": name, "title": name, "webpage_url": url, "duration": None}
    return info, target


# ─── Whisper ──────────────────────────────────────────────────────────────────

def whisper_transcribe(
    audio_path: Path, model_size: str, language: Optional[str], beam_size: int = 5
) -> tuple[list[dict], str, float]:
    from faster_whisper import WhisperModel  # type: ignore

    print(f"[load] model={model_size} device=cuda fp16", flush=True)
    model = WhisperModel(model_size, device="cuda", compute_type="float16")
    print(f"[transcribe] {audio_path.name}", flush=True)
    segs_iter, info = model.transcribe(
        str(audio_path),
        language=language,
        vad_filter=True,
        beam_size=beam_size,
    )
    segments: list[dict] = []
    for s in segs_iter:
        segments.append({"start": s.start, "end": s.end, "text": s.text.strip()})
        if len(segments) % 25 == 0:
            print(f"[progress] {len(segments)} segments, t={s.end:.0f}s", flush=True)
    return segments, info.language, info.duration


# ─── Probe duration for local files (so the JSON has it) ──────────────────────

def probe_duration(path: Path) -> Optional[float]:
    try:
        import av  # type: ignore
    except Exception:
        return None
    try:
        c = av.open(str(path))
        d = float(c.duration) / av.time_base if c.duration else None
        c.close()
        return d
    except Exception:
        return None


# ─── Main ─────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description="Transcribe audio/video to text.")
    ap.add_argument(
        "source",
        help="YouTube URL, Google Drive URL/ID, local file path, or other http(s) URL",
    )
    ap.add_argument("--lang", default="en", help="Caption / language hint (default: en)")
    ap.add_argument(
        "--model",
        default="large-v3",
        choices=["tiny", "base", "small", "medium", "large-v2", "large-v3"],
        help="Whisper model size (default: large-v3)",
    )
    ap.add_argument(
        "--force-whisper",
        action="store_true",
        help="Skip YouTube caption track even if available",
    )
    ap.add_argument(
        "--no-auto-captions",
        action="store_true",
        help="For YouTube: reject auto-generated captions, fall back to Whisper",
    )
    ap.add_argument(
        "--out",
        help="Write JSON to this path instead of stdout. Recommended for long videos.",
    )
    ap.add_argument("--text-only", action="store_true", help="Print plain text instead of JSON")
    ap.add_argument(
        "--beam-size",
        type=int,
        default=5,
        help="Whisper beam size (default 5; higher = slower + slightly more accurate)",
    )
    args = ap.parse_args()

    source_type, normalized = classify(args.source)
    print(f"[classify] source_type={source_type}", flush=True)

    info: dict = {}
    segments: list[dict] = []
    source_label: str = "whisper"
    language: Optional[str] = None
    duration: Optional[float] = None

    # YouTube captions fast-path
    if source_type == "youtube" and not args.force_whisper:
        info, caps, is_auto = youtube_captions(normalized, args.lang)
        if caps and not (is_auto and args.no_auto_captions):
            segments = caps
            source_label = "auto-captions" if is_auto else "manual-captions"
            language = args.lang
            duration = info.get("duration")

    if not segments:
        # Need audio to feed Whisper.
        if source_type == "local":
            audio_path = Path(normalized)
            info = {"id": audio_path.stem, "title": audio_path.name, "webpage_url": None}
            duration = probe_duration(audio_path)
            segments, language, _dur = whisper_transcribe(
                audio_path, args.model, args.lang or None, args.beam_size
            )
            if duration is None:
                duration = _dur
        else:
            with tempfile.TemporaryDirectory(prefix="mt-") as td:
                tdp = Path(td)
                if source_type == "youtube":
                    info, audio = download_youtube(normalized, tdp)
                elif source_type == "drive":
                    info, audio = download_drive(normalized, tdp)
                else:  # http
                    info, audio = download_http(normalized, tdp)
                segments, language, duration = whisper_transcribe(
                    audio, args.model, args.lang or None, args.beam_size
                )
        source_label = "whisper"

    full_text = re.sub(r"\s+", " ", " ".join(s["text"] for s in segments).strip())

    payload = {
        "source_type": source_type,
        "source": normalized,
        "title": info.get("title"),
        "channel": info.get("uploader") or info.get("channel"),
        "duration_s": duration or info.get("duration"),
        "url": info.get("webpage_url"),
        "video_id": info.get("id"),
        "source_method": source_label,
        "language": language,
        "model": args.model if source_label == "whisper" else None,
        "segment_count": len(segments),
        "segments": segments,
        "text": full_text,
    }

    if args.out:
        Path(args.out).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[done] {len(segments)} segments, {len(full_text)} chars -> {args.out}", flush=True)
    elif args.text_only:
        sys.stdout.write(full_text + "\n")
    else:
        json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())

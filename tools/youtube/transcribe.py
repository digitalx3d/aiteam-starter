"""Transcribe a YouTube video to text.

Strategy:
  1. Use yt-dlp to fetch metadata + caption tracks.
  2. If a usable English caption track exists (manual or auto), parse it. Free, instant.
  3. Otherwise download audio (m4a/opus) and transcribe with faster-whisper on GPU.

Output is JSON on stdout: {title, channel, duration_s, source, language, segments, text}.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

# Ensure CTranslate2 / faster-whisper can find bundled CUDA DLLs on Windows.
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except Exception:
        pass
    site_pkgs = next((p for p in sys.path if "site-packages" in p), None)
    if site_pkgs:
        for sub in ("nvidia/cudnn/bin", "nvidia/cublas/bin", "nvidia/cuda_nvrtc/bin"):
            d = Path(site_pkgs) / sub
            if d.is_dir():
                os.add_dll_directory(str(d))

import yt_dlp  # noqa: E402


def _find_caption_url(info: dict, lang: str) -> tuple[str | None, bool]:
    """Return (url, is_auto) for the best caption track in the requested language."""
    for track_key, is_auto in (("subtitles", False), ("automatic_captions", True)):
        tracks = info.get(track_key) or {}
        if lang in tracks:
            for entry in tracks[lang]:
                if entry.get("ext") in ("vtt", "srv3", "srt", "json3"):
                    return entry["url"], is_auto
    return None, False


def _vtt_to_segments(vtt_text: str) -> list[dict[str, Any]]:
    """Parse WebVTT into [{start, end, text}, ...]. Tolerates yt-dlp's auto-caption quirks."""
    segments: list[dict[str, Any]] = []
    ts_re = re.compile(
        r"(\d{2}:\d{2}:\d{2}\.\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}\.\d{3})"
    )
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


def fetch_captions(url: str, lang: str) -> tuple[dict, list[dict] | None, bool]:
    """Returns (video_info, segments_or_none, is_auto). segments=None means none available."""
    ydl_opts = {
        "skip_download": True,
        "quiet": True,
        "no_warnings": True,
        "writesubtitles": False,
        "writeautomaticsub": False,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)

    cap_url, is_auto = _find_caption_url(info, lang)
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
                txt = "".join(seg.get("utf8", "") for seg in (ev.get("segs") or []))
                txt = txt.replace("\n", " ").strip()
                if txt:
                    segs.append({"start": start, "end": start + dur, "text": txt})
        except Exception:
            segs = []
    return info, (segs or None), is_auto


def download_audio(url: str, dest_dir: Path) -> tuple[dict, Path]:
    """Download bestaudio to dest_dir, return (info, audio_path)."""
    out_tpl = str(dest_dir / "%(id)s.%(ext)s")
    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": out_tpl,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "postprocessors": [
            {"key": "FFmpegExtractAudio", "preferredcodec": "wav", "preferredquality": "0"}
        ],
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
    audio_path = dest_dir / f"{info['id']}.wav"
    if not audio_path.exists():
        cands = list(dest_dir.glob(f"{info['id']}.*"))
        if not cands:
            raise FileNotFoundError(f"yt-dlp produced no audio file in {dest_dir}")
        audio_path = cands[0]
    return info, audio_path


def whisper_transcribe(audio_path: Path, model_size: str, language: str | None) -> tuple[list[dict], str]:
    from faster_whisper import WhisperModel

    model = WhisperModel(model_size, device="cuda", compute_type="float16")
    segs_iter, info = model.transcribe(
        str(audio_path),
        language=language,
        vad_filter=True,
        beam_size=5,
    )
    segments = [{"start": s.start, "end": s.end, "text": s.text.strip()} for s in segs_iter]
    return segments, info.language


def main() -> int:
    ap = argparse.ArgumentParser(description="Transcribe a YouTube video.")
    ap.add_argument("url", help="YouTube URL")
    ap.add_argument("--lang", default="en", help="Preferred caption language code (default: en)")
    ap.add_argument(
        "--model",
        default="large-v3",
        choices=["tiny", "base", "small", "medium", "large-v2", "large-v3"],
        help="Whisper model size when captions unavailable",
    )
    ap.add_argument(
        "--force-whisper",
        action="store_true",
        help="Skip caption track and always transcribe audio with Whisper",
    )
    ap.add_argument(
        "--no-auto-captions",
        action="store_true",
        help="Only use manual captions; fall back to Whisper if only auto-captions exist",
    )
    ap.add_argument("--text-only", action="store_true", help="Print plain transcript text instead of JSON")
    args = ap.parse_args()

    info: dict
    segments: list[dict]
    source: str
    language: str | None = None

    if args.force_whisper:
        info_only_opts = {"skip_download": True, "quiet": True, "no_warnings": True}
        with yt_dlp.YoutubeDL(info_only_opts) as ydl:
            info = ydl.extract_info(args.url, download=False)
        segments = []
        source = "whisper"
    else:
        info, caps, is_auto = fetch_captions(args.url, args.lang)
        if caps and not (is_auto and args.no_auto_captions):
            segments = caps
            source = "auto-captions" if is_auto else "manual-captions"
            language = args.lang
        else:
            segments = []
            source = "whisper"

    if source == "whisper":
        with tempfile.TemporaryDirectory(prefix="yt-tx-") as td:
            tdp = Path(td)
            info, audio = download_audio(args.url, tdp)
            segments, language = whisper_transcribe(audio, args.model, args.lang or None)

    full_text = " ".join(s["text"] for s in segments).strip()
    full_text = re.sub(r"\s+", " ", full_text)

    payload = {
        "title": info.get("title"),
        "channel": info.get("uploader") or info.get("channel"),
        "duration_s": info.get("duration"),
        "url": info.get("webpage_url") or args.url,
        "video_id": info.get("id"),
        "source": source,
        "language": language,
        "model": args.model if source == "whisper" else None,
        "segment_count": len(segments),
        "segments": segments,
        "text": full_text,
    }

    if args.text_only:
        print(payload["text"])
    else:
        json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())

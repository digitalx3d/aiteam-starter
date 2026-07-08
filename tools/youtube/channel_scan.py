"""Scan a YouTube creator's recent uploads for videos matching given keywords.

Resolves a creator name to a channel via yt-dlp's search, then flat-lists the
channel's /videos page (cheap — title + id + date only) and returns matches.

Usage:
  python channel_scan.py --creator "Matthew Berman" --pattern "AI\\s*OS|command\\s*center"
  python channel_scan.py --creators-file creators.txt --pattern "..." --limit 100
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import re
import sys
from typing import Any

import yt_dlp


def _ydl(opts: dict[str, Any]) -> yt_dlp.YoutubeDL:
    base = {"quiet": True, "no_warnings": True, "skip_download": True, "noprogress": True}
    base.update(opts)
    return yt_dlp.YoutubeDL(base)


_NORM_RE = re.compile(r"[^a-z0-9]+")


def _norm(s: str) -> str:
    return _NORM_RE.sub("", (s or "").lower())


def _name_score(query: str, channel_name: str) -> int:
    """Higher = better match. Exact name = best, then substring, then token overlap."""
    if not channel_name:
        return 0
    q, c = _norm(query), _norm(channel_name)
    if q == c:
        return 1000
    if q and q in c:
        return 500 - (len(c) - len(q))
    if c and c in q:
        return 250
    q_toks = set(re.findall(r"[a-z0-9]+", query.lower()))
    c_toks = set(re.findall(r"[a-z0-9]+", channel_name.lower()))
    return 10 * len(q_toks & c_toks)


def resolve_channel(creator: str) -> dict[str, Any] | None:
    """Search YouTube for the creator name; return the channel whose name best matches."""
    queries = [f"ytsearch10:{creator} channel", f"ytsearch10:{creator}"]
    candidates: dict[str, dict[str, Any]] = {}
    with _ydl({"extract_flat": True}) as ydl:
        for q in queries:
            try:
                info = ydl.extract_info(q, download=False) or {}
            except Exception:
                continue
            for entry in info.get("entries") or []:
                if not entry:
                    continue
                cu = entry.get("channel_url") or (entry.get("url") if "/channel/" in (entry.get("url") or "") or "/@" in (entry.get("url") or "") else None)
                if not cu:
                    continue
                ch_name = entry.get("channel") or entry.get("uploader")
                if entry.get("ie_key") == "YoutubeTab" and not ch_name:
                    ch_name = entry.get("title")
                if cu not in candidates:
                    candidates[cu] = {
                        "channel_title": ch_name,
                        "channel_url": cu,
                        "score": _name_score(creator, ch_name or ""),
                    }
    if not candidates:
        return None
    best = max(candidates.values(), key=lambda c: c["score"])
    return {
        "creator_query": creator,
        "channel_title": best["channel_title"],
        "channel_url": best["channel_url"],
        "subscriber_hint": None,
        "match_score": best["score"],
    }


def list_recent_videos(channel_url: str, limit: int) -> list[dict[str, Any]]:
    """Flat-list the most recent videos from a channel's /videos tab."""
    if not channel_url.rstrip("/").endswith("/videos"):
        url = channel_url.rstrip("/") + "/videos"
    else:
        url = channel_url
    with _ydl({"extract_flat": True, "playlistend": limit}) as ydl:
        info = ydl.extract_info(url, download=False) or {}
    out = []
    for entry in info.get("entries") or []:
        if not entry:
            continue
        out.append({
            "id": entry.get("id"),
            "title": entry.get("title"),
            "url": entry.get("url") or f"https://www.youtube.com/watch?v={entry.get('id')}",
            "duration_s": entry.get("duration"),
            "view_count": entry.get("view_count"),
            "upload_epoch": entry.get("timestamp"),
            "live_status": entry.get("live_status"),
        })
    return out


def scan_creator(creator: str, pattern: re.Pattern[str], limit: int, channel_url: str | None = None) -> dict[str, Any]:
    if channel_url:
        ch = {"creator_query": creator, "channel_title": creator, "channel_url": channel_url, "subscriber_hint": None}
    else:
        ch = resolve_channel(creator)
        if not ch:
            return {"creator_query": creator, "error": "channel not found"}
    try:
        vids = list_recent_videos(ch["channel_url"], limit)
    except Exception as e:
        return {**ch, "error": f"list_videos failed: {e}"}
    matches = [v for v in vids if v.get("title") and pattern.search(v["title"])]
    return {
        **ch,
        "videos_scanned": len(vids),
        "match_count": len(matches),
        "matches": matches,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Scan YouTube creators for matching videos.")
    ap.add_argument("--creator", action="append", default=[], help="Creator name (repeatable)")
    ap.add_argument(
        "--creators-file",
        help=(
            "File with one creator per line. Format: 'Creator Name' or "
            "'Creator Name | https://www.youtube.com/channel/UC...' to pin a channel URL."
        ),
    )
    ap.add_argument(
        "--pattern",
        required=True,
        help="Case-insensitive regex matched against video titles",
    )
    ap.add_argument("--limit", type=int, default=100, help="Videos per channel to scan (default 100)")
    ap.add_argument("--workers", type=int, default=5, help="Parallel creator scans (default 5)")
    args = ap.parse_args()

    creators: list[tuple[str, str | None]] = [(c, None) for c in args.creator]
    if args.creators_file:
        with open(args.creators_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "|" in line:
                    name, url = [p.strip() for p in line.split("|", 1)]
                    creators.append((name, url or None))
                else:
                    creators.append((line, None))
    if not creators:
        ap.error("provide at least one --creator or --creators-file")

    pat = re.compile(args.pattern, re.IGNORECASE)
    order = [c[0] for c in creators]

    with cf.ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = {ex.submit(scan_creator, name, pat, args.limit, url): name for name, url in creators}
        results = []
        for fut in cf.as_completed(futures):
            results.append(fut.result())

    results.sort(key=lambda r: order.index(r["creator_query"]))
    json.dump({"pattern": args.pattern, "limit": args.limit, "results": results}, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())

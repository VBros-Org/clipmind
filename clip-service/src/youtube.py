"""YouTube channel listing and remote audio download helpers."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse, urlunparse

from yt_dlp import YoutubeDL

CHANNEL_HANDLE_RE = re.compile(r"^@[A-Za-z0-9._-]{2,100}$")
RESERVED_YOUTUBE_PATHS = {
    "embed",
    "feed",
    "playlist",
    "results",
    "shorts",
    "watch",
}
YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
}
YT_BLOCKED_PATTERNS = (
    "sign in to confirm",
    "confirm you're not a bot",
    "confirm you’re not a bot",
    "http error 403",
    "403: forbidden",
    "403 forbidden",
)


@dataclass(frozen=True)
class YoutubeVideo:
    video_id: str
    title: str
    duration_s: int | None
    url: str

    def to_response(self) -> dict[str, object]:
        return {
            "video_id": self.video_id,
            "title": self.title,
            "duration_s": self.duration_s,
            "url": self.url,
        }


class YoutubeValidationError(ValueError):
    """Raised when user input is not a supported YouTube URL or handle."""


class YoutubeBlockedError(RuntimeError):
    """Raised when YouTube blocks the server-side yt-dlp request."""


class YoutubeRemoteError(RuntimeError):
    """Raised for non-validation yt-dlp failures that are not bot blocks."""


class YoutubeDurationError(ValueError):
    def __init__(self, duration_s: int, max_duration_s: int) -> None:
        self.duration_s = duration_s
        self.max_duration_s = max_duration_s
        super().__init__(
            f"Video is {duration_s}s, longer than the {max_duration_s}s cap."
        )


def normalize_youtube_channel_url(value: str) -> str:
    text = value.strip()
    if not text:
        raise YoutubeValidationError("channel_url is required.")

    if CHANNEL_HANDLE_RE.fullmatch(text):
        return f"https://www.youtube.com/{text}/videos"

    if text.lower().startswith(("youtube.com/", "www.youtube.com/", "m.youtube.com/")):
        text = f"https://{text}"

    parsed = urlparse(text)
    host = parsed.netloc.lower()
    if parsed.scheme not in {"http", "https"} or host not in YOUTUBE_HOSTS:
        raise YoutubeValidationError(
            "channel_url must be a YouTube channel URL or @handle."
        )

    parts = [part for part in parsed.path.split("/") if part]
    if not parts:
        raise YoutubeValidationError(
            "channel_url must be a YouTube channel URL or @handle."
        )

    first = parts[0]
    if first.startswith("@"):
        channel_path = f"/{first}/videos"
    elif first in {"channel", "c", "user"} and len(parts) >= 2:
        channel_path = f"/{first}/{parts[1]}/videos"
    elif first not in RESERVED_YOUTUBE_PATHS and len(parts) == 1:
        channel_path = f"/{first}/videos"
    else:
        raise YoutubeValidationError(
            "channel_url must be a YouTube channel URL or @handle."
        )

    return urlunparse(("https", "www.youtube.com", channel_path, "", "", ""))


def normalize_youtube_video_url(value: str) -> str:
    text = value.strip()
    if not text:
        raise YoutubeValidationError("video_url is required.")

    if text.lower().startswith(("youtube.com/", "www.youtube.com/", "youtu.be/")):
        text = f"https://{text}"

    parsed = urlparse(text)
    host = parsed.netloc.lower()
    if parsed.scheme not in {"http", "https"}:
        raise YoutubeValidationError("video_url must be a YouTube video URL.")

    if host == "youtu.be":
        video_id = parsed.path.strip("/").split("/", 1)[0]
        if not video_id:
            raise YoutubeValidationError("video_url must be a YouTube video URL.")
        return f"https://www.youtube.com/watch?v={video_id}"

    if host not in YOUTUBE_HOSTS:
        raise YoutubeValidationError("video_url must be a YouTube video URL.")

    parts = [part for part in parsed.path.split("/") if part]
    if parts and parts[0] == "watch":
        video_id = parse_qs(parsed.query).get("v", [""])[0].strip()
        if not video_id:
            raise YoutubeValidationError("video_url must include a video id.")
        return f"https://www.youtube.com/watch?v={video_id}"

    if len(parts) >= 2 and parts[0] == "shorts":
        return f"https://www.youtube.com/shorts/{parts[1]}"

    if len(parts) >= 2 and parts[0] == "embed":
        return f"https://www.youtube.com/watch?v={parts[1]}"

    raise YoutubeValidationError("video_url must be a YouTube video URL.")


def list_youtube_channel_uploads(channel_url: str, limit: int = 10) -> list[YoutubeVideo]:
    normalized_url = normalize_youtube_channel_url(channel_url)
    options = {
        "extract_flat": "in_playlist",
        "ignoreerrors": True,
        "no_warnings": True,
        "playlistend": limit,
        "quiet": True,
        "skip_download": True,
    }
    info = _extract_info(normalized_url, options, download=False)
    entries = info.get("entries") or []

    videos: list[YoutubeVideo] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue

        video_id = str(entry.get("id") or "").strip()
        video_url = _entry_video_url(entry, video_id)
        if not video_id or not video_url:
            continue

        videos.append(
            YoutubeVideo(
                video_id=video_id,
                title=str(entry.get("title") or "Untitled video").strip(),
                duration_s=_duration_seconds(entry.get("duration")),
                url=video_url,
            )
        )
        if len(videos) >= limit:
            break

    return videos


def download_youtube_audio(
    video_url: str,
    temp_dir: Path,
    max_duration_s: int,
) -> Path:
    normalized_url = normalize_youtube_video_url(video_url)
    metadata_options = {
        "noplaylist": True,
        "no_warnings": True,
        "quiet": True,
        "skip_download": True,
    }
    metadata = _extract_info(normalized_url, metadata_options, download=False)
    live_status = str(metadata.get("live_status") or "").strip()
    if live_status != "not_live":
        raise YoutubeValidationError("Live YouTube URLs are not supported.")

    duration_s = _duration_seconds(metadata.get("duration"))
    if duration_s is None:
        raise YoutubeValidationError("YouTube video duration is unavailable.")
    if duration_s > max_duration_s:
        raise YoutubeDurationError(duration_s, max_duration_s)

    output_template = str(temp_dir / "remote.%(ext)s")
    download_options = {
        "format": "bestaudio/best",
        "noplaylist": True,
        "no_warnings": True,
        "outtmpl": output_template,
        "quiet": True,
    }
    info = _extract_info(normalized_url, download_options, download=True)
    return _downloaded_audio_path(temp_dir, info)


def is_youtube_blocked_error(error: BaseException) -> bool:
    message = str(error).lower()
    return any(pattern in message for pattern in YT_BLOCKED_PATTERNS)


def _extract_info(
    url: str,
    options: dict[str, Any],
    download: bool,
) -> dict[str, Any]:
    try:
        with YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=download)
    except Exception as exc:
        if is_youtube_blocked_error(exc):
            raise YoutubeBlockedError("YouTube blocked this server request.") from exc
        raise YoutubeRemoteError(_short_ytdlp_error(exc)) from exc

    if not isinstance(info, dict):
        raise YoutubeRemoteError("yt-dlp returned no video metadata.")
    return info


def _entry_video_url(entry: dict[str, Any], video_id: str) -> str | None:
    for key in ("webpage_url", "url"):
        value = entry.get(key)
        if isinstance(value, str) and value.startswith(("http://", "https://")):
            return value

    if video_id:
        return f"https://www.youtube.com/watch?v={video_id}"
    return None


def _duration_seconds(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        duration = float(value)
    except (TypeError, ValueError):
        return None
    if duration < 0:
        return None
    return int(round(duration))


def _downloaded_audio_path(temp_dir: Path, info: dict[str, Any]) -> Path:
    requested_downloads = info.get("requested_downloads")
    if isinstance(requested_downloads, list):
        for item in requested_downloads:
            if isinstance(item, dict):
                filepath = item.get("filepath")
                if isinstance(filepath, str) and Path(filepath).exists():
                    return Path(filepath)

    filename = info.get("_filename")
    if isinstance(filename, str) and Path(filename).exists():
        return Path(filename)

    candidates = [
        path
        for path in temp_dir.glob("remote.*")
        if path.is_file() and not path.name.endswith((".part", ".ytdl"))
    ]
    if not candidates:
        raise YoutubeRemoteError("yt-dlp did not produce an audio file.")
    return candidates[0]


def _short_ytdlp_error(error: BaseException) -> str:
    message = str(error).strip() or "yt-dlp failed."
    return " ".join(message.split())[-500:]

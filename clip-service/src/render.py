"""ffmpeg rendering helpers for finished clips."""

from __future__ import annotations

import subprocess
from pathlib import Path

from .presets import CaptionPreset
from .subtitles import generate_ass
from .transcribe import Transcript

OUTPUT_WIDTH = 1080
OUTPUT_HEIGHT = 1920
THUMBNAIL_WIDTH = 540
THUMBNAIL_HEIGHT = 960


def cut_segment_for_transcription(
    source_path: Path,
    output_path: Path,
    start_ms: int,
    duration_ms: int,
) -> None:
    _run_checked(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            _seconds_arg(start_ms),
            "-i",
            str(source_path),
            "-t",
            _seconds_arg(duration_ms),
            "-map",
            "0:v?",
            "-map",
            "0:a?",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "28",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "96k",
            str(output_path),
        ],
        "ffmpeg transcription cut",
    )


def render_cut_with_subtitles(
    source_path: Path,
    output_path: Path,
    transcript: Transcript,
    preset: CaptionPreset,
    start_ms: int,
    duration_ms: int,
    work_dir: Path,
) -> None:
    ass_path = work_dir / "subtitles.ass"
    ass_path.write_text(generate_ass(transcript, preset, duration_ms), encoding="utf-8")

    video_filter = ",".join(
        [
            (
                f"scale={OUTPUT_WIDTH}:{OUTPUT_HEIGHT}:"
                "force_original_aspect_ratio=increase"
            ),
            f"crop={OUTPUT_WIDTH}:{OUTPUT_HEIGHT}",
            "setsar=1",
            f"ass={_filter_path(ass_path)}",
        ]
    )

    _run_checked(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            _seconds_arg(start_ms),
            "-i",
            str(source_path),
            "-t",
            _seconds_arg(duration_ms),
            "-map",
            "0:v:0",
            "-map",
            "0:a?",
            "-vf",
            video_filter,
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-movflags",
            "+faststart",
            str(output_path),
        ],
        "ffmpeg clip render",
    )


def render_thumbnail_frame(
    source_path: Path,
    output_path: Path,
    timestamp_ms: int,
    width: int = THUMBNAIL_WIDTH,
    height: int = THUMBNAIL_HEIGHT,
) -> None:
    video_filter = ",".join(
        [
            f"scale={width}:{height}:force_original_aspect_ratio=decrease",
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2",
            "setsar=1",
        ]
    )

    _run_checked(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            _seconds_arg(timestamp_ms),
            "-i",
            str(source_path),
            "-frames:v",
            "1",
            "-map",
            "0:v:0",
            "-vf",
            video_filter,
            "-q:v",
            "3",
            str(output_path),
        ],
        "ffmpeg thumbnail render",
    )


def _run_checked(command: list[str], label: str) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as exc:
        output = (exc.stderr or exc.stdout or "").strip()
        detail = f": {output[-1200:]}" if output else ""
        raise RuntimeError(f"{label} failed{detail}") from exc


def _seconds_arg(ms: int) -> str:
    return f"{ms / 1000:.3f}"


def _filter_path(path: Path) -> str:
    return (
        str(path)
        .replace("\\", "\\\\")
        .replace(":", "\\:")
        .replace("'", "\\'")
        .replace(",", "\\,")
    )

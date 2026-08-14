"""ffmpeg rendering helpers for finished clips."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from .presets import CaptionPreset
from .subtitles import generate_ass
from .transcribe import Transcript

OUTPUT_WIDTH = 1080
OUTPUT_HEIGHT = 1920
THUMBNAIL_WIDTH = 540
THUMBNAIL_HEIGHT = 960
RENDER_DURATION_TOLERANCE_MS = 1_500


class RenderOutputValidationError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


def cut_segment_for_transcription(
    source_path: Path | str,
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
            *_seeked_input_args(source_path, start_ms, start_ms + duration_ms),
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
    source_path: Path | str,
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
            *_seeked_input_args(source_path, start_ms, start_ms + duration_ms),
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
    source_path: Path | str,
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
            *_seeked_input_args(source_path, timestamp_ms, timestamp_ms + 1_000),
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


def validate_rendered_video(output_path: Path, expected_duration_ms: int) -> None:
    if not output_path.exists() or output_path.stat().st_size <= 0:
        raise RenderOutputValidationError(
            "empty_render_output",
            "ffmpeg produced an empty clip.",
        )

    try:
        result = _run_checked(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "stream=codec_type",
                "-show_entries",
                "format=duration",
                "-of",
                "json",
                str(output_path),
            ],
            "ffprobe rendered clip",
        )
    except RuntimeError as exc:
        raise RenderOutputValidationError("render_probe_failed", str(exc)) from exc

    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RenderOutputValidationError(
            "render_probe_invalid",
            "ffprobe returned invalid JSON for the rendered clip.",
        ) from exc

    streams = payload.get("streams")
    if not isinstance(streams, list) or not any(
        isinstance(stream, dict) and stream.get("codec_type") == "video"
        for stream in streams
    ):
        raise RenderOutputValidationError(
            "render_missing_video_stream",
            "Rendered clip has no video stream.",
        )

    duration_seconds = payload.get("format", {}).get("duration")
    if duration_seconds is None:
        raise RenderOutputValidationError(
            "render_duration_missing",
            "ffprobe did not return a rendered clip duration.",
        )

    try:
        actual_duration_ms = int(round(float(duration_seconds) * 1000))
    except (TypeError, ValueError) as exc:
        raise RenderOutputValidationError(
            "render_duration_invalid",
            "ffprobe returned an invalid rendered clip duration.",
        ) from exc

    if actual_duration_ms <= 0:
        raise RenderOutputValidationError(
            "render_duration_invalid",
            "Rendered clip duration must be positive.",
        )

    tolerance_ms = max(
        RENDER_DURATION_TOLERANCE_MS,
        int(round(expected_duration_ms * 0.10)),
    )
    lower_bound_ms = max(1, expected_duration_ms - tolerance_ms)
    upper_bound_ms = expected_duration_ms + tolerance_ms
    if actual_duration_ms < lower_bound_ms or actual_duration_ms > upper_bound_ms:
        raise RenderOutputValidationError(
            "render_duration_mismatch",
            "Rendered clip duration does not match the requested window.",
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


def _seeked_input_args(source_path: Path | str, start_ms: int, end_ms: int) -> list[str]:
    return [
        "-ss",
        _seconds_arg(start_ms),
        "-to",
        _seconds_arg(end_ms),
        "-i",
        str(source_path),
    ]


def _filter_path(path: Path) -> str:
    return (
        str(path)
        .replace("\\", "\\\\")
        .replace(":", "\\:")
        .replace("'", "\\'")
        .replace(",", "\\,")
    )

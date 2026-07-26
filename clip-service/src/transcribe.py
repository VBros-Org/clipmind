"""Video audio extraction and Whisper transcription."""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from openai import OpenAI

FALLBACK_TRANSCRIBE_MODEL = "gpt-4o-transcribe"


@dataclass(frozen=True)
class TranscriptSegment:
    start_ms: int
    end_ms: int
    text: str


@dataclass(frozen=True)
class TranscriptWord:
    start_ms: int
    end_ms: int
    word: str


@dataclass(frozen=True)
class Transcript:
    text: str
    segments: list[TranscriptSegment]
    words: list[TranscriptWord]


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


def probe_video_duration_ms(video_path: Path) -> int:
    result = _run_checked(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            str(video_path),
        ],
        "ffprobe duration",
    )

    payload = json.loads(result.stdout)
    duration_seconds = payload.get("format", {}).get("duration")
    if duration_seconds is None:
        raise RuntimeError("ffprobe did not return a video duration.")

    return max(0, int(round(float(duration_seconds) * 1000)))


def extract_audio(video_path: Path, audio_path: Path) -> None:
    _run_checked(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(video_path),
            "-vn",
            "-ar",
            "16000",
            "-b:a",
            "96k",
            str(audio_path),
        ],
        "ffmpeg audio extraction",
    )


def transcribe_video(
    video_path: Path,
    api_key: str,
    work_dir: Path,
    duration_ms: int | None = None,
) -> Transcript:
    audio_path = work_dir / "audio.mp3"
    extract_audio(video_path, audio_path)
    return transcribe_audio(audio_path, api_key, duration_ms)


def transcribe_audio(
    audio_path: Path,
    api_key: str,
    duration_ms: int | None = None,
) -> Transcript:
    client = OpenAI(api_key=api_key)
    with audio_path.open("rb") as audio_file:
        response = client.audio.transcriptions.create(
            model="whisper-1",
            file=audio_file,
            response_format="verbose_json",
            timestamp_granularities=["segment", "word"],
        )

    transcript = parse_whisper_response(response)
    if transcript.text or transcript.segments:
        return transcript

    # Some sparse gameplay audio returns blank from timestamped whisper-1 even
    # when short spoken lines are present. Fall back to a text-only OpenAI
    # transcription pass and attach a coarse full-source segment if it hears text.
    text = transcribe_audio_text_fallback(audio_path, client)
    if not text:
        return transcript

    segments = [
        TranscriptSegment(start_ms=0, end_ms=max(0, duration_ms or 0), text=text)
    ]
    return Transcript(text=text, segments=segments, words=[])


def transcribe_audio_text_fallback(audio_path: Path, client: OpenAI) -> str:
    with audio_path.open("rb") as audio_file:
        response = client.audio.transcriptions.create(
            model=FALLBACK_TRANSCRIBE_MODEL,
            file=audio_file,
            response_format="json",
        )

    payload = _response_to_dict(response)
    return str(payload.get("text") or "").strip()


def parse_whisper_response(response: Any) -> Transcript:
    payload = _response_to_dict(response)
    text = str(payload.get("text") or "").strip()

    segments: list[TranscriptSegment] = []
    for item in payload.get("segments") or []:
        segment_text = str(item.get("text") or "").strip()
        if not segment_text:
            continue
        segments.append(
            TranscriptSegment(
                start_ms=_seconds_to_ms(item.get("start")),
                end_ms=_seconds_to_ms(item.get("end")),
                text=segment_text,
            )
        )

    words: list[TranscriptWord] = []
    for item in payload.get("words") or []:
        word = str(item.get("word") or "").strip()
        if not word:
            continue
        words.append(
            TranscriptWord(
                start_ms=_seconds_to_ms(item.get("start")),
                end_ms=_seconds_to_ms(item.get("end")),
                word=word,
            )
        )

    return Transcript(text=text, segments=segments, words=words)


def _response_to_dict(response: Any) -> dict[str, Any]:
    if isinstance(response, dict):
        return response
    if hasattr(response, "model_dump"):
        return response.model_dump()
    if hasattr(response, "dict"):
        return response.dict()
    raise TypeError("Unexpected transcription response shape.")


def _seconds_to_ms(value: Any) -> int:
    if value is None:
        return 0
    return max(0, int(round(float(value) * 1000)))

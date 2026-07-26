"""ClipMind clip service (stateless)."""

from __future__ import annotations

import json
import secrets
import shutil
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from starlette.background import BackgroundTask
from starlette.datastructures import UploadFile
from starlette.responses import FileResponse

from .candidates import build_candidates
from .config import get_settings
from .presets import CaptionPreset, get_caption_preset, validate_caption_presets
from .render import cut_segment_for_transcription, render_cut_with_subtitles
from .subtitles import transcript_for_cut, transcript_from_payload
from .transcribe import Transcript, probe_video_duration_ms, transcribe_video

MAX_DOWNLOAD_BYTES = 1_000_000_000


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    get_settings()
    validate_caption_presets()
    yield


app = FastAPI(title="ClipMind Clip Service", lifespan=lifespan)


@dataclass(frozen=True)
class CutRequest:
    video_path: Path
    preset: CaptionPreset
    start_ms: int
    end_ms: int
    trim_start_ms: int
    trim_end_ms: int
    transcript_payload: object | None

    @property
    def effective_start_ms(self) -> int:
        return self.start_ms + self.trim_start_ms

    @property
    def effective_end_ms(self) -> int:
        return self.end_ms - self.trim_end_ms


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def _require_service_token(
    authorization: str | None = Header(default=None),
) -> None:
    settings = get_settings()
    expected = f"Bearer {settings.clip_service_token}"
    if not authorization or not secrets.compare_digest(authorization, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unauthorized",
        )


@app.post("/candidates")
async def candidates(
    request: Request,
    _: None = Depends(_require_service_token),
) -> dict[str, object]:
    settings = get_settings()

    with tempfile.TemporaryDirectory(prefix="clipmind-candidates-") as raw_temp_dir:
        temp_dir = Path(raw_temp_dir)
        video_path = await _materialize_video_input(request, temp_dir)
        duration_ms = probe_video_duration_ms(video_path)
        transcript = transcribe_video(
            video_path,
            settings.openai_api_key,
            temp_dir,
            duration_ms,
        )
        candidate_windows = build_candidates(video_path, transcript, duration_ms)

    return {
        "duration_ms": duration_ms,
        "candidates": [window.to_response() for window in candidate_windows],
    }


@app.post("/transcribe")
async def transcribe(
    request: Request,
    _: None = Depends(_require_service_token),
) -> dict[str, object]:
    settings = get_settings()

    with tempfile.TemporaryDirectory(prefix="clipmind-transcribe-") as raw_temp_dir:
        temp_dir = Path(raw_temp_dir)
        video_path = await _materialize_video_input(request, temp_dir)
        duration_ms = probe_video_duration_ms(video_path)
        transcript = transcribe_video(
            video_path,
            settings.openai_api_key,
            temp_dir,
            duration_ms,
        )

    return _transcript_to_response(transcript)


@app.post("/cut")
async def cut_clip(
    request: Request,
    _: None = Depends(_require_service_token),
) -> FileResponse:
    settings = get_settings()
    raw_temp_dir = tempfile.mkdtemp(prefix="clipmind-cut-")
    temp_dir = Path(raw_temp_dir)

    try:
        cut_request = await _parse_cut_request(request, temp_dir)
        effective_start_ms = cut_request.effective_start_ms
        effective_end_ms = cut_request.effective_end_ms
        duration_ms = effective_end_ms - effective_start_ms

        source_duration_ms = probe_video_duration_ms(cut_request.video_path)
        if effective_start_ms >= source_duration_ms or effective_end_ms > source_duration_ms:
            raise HTTPException(
                status_code=422,
                detail="Requested window is outside the source video duration.",
            )

        if cut_request.transcript_payload is None:
            transcript_source_path = temp_dir / "transcribe-window.mp4"
            cut_segment_for_transcription(
                cut_request.video_path,
                transcript_source_path,
                effective_start_ms,
                duration_ms,
            )
            transcript = transcribe_video(
                transcript_source_path,
                settings.openai_api_key,
                temp_dir,
                duration_ms,
            )
            subtitles = transcript_for_cut(transcript, 0, duration_ms)
        else:
            try:
                transcript = transcript_from_payload(cut_request.transcript_payload)
            except (TypeError, ValueError) as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc
            subtitles = transcript_for_cut(
                transcript,
                effective_start_ms,
                effective_end_ms,
            )

        output_path = temp_dir / "clipmind-cut.mp4"
        render_cut_with_subtitles(
            cut_request.video_path,
            output_path,
            subtitles,
            cut_request.preset,
            effective_start_ms,
            duration_ms,
            temp_dir,
        )

        return FileResponse(
            output_path,
            media_type="video/mp4",
            filename="clipmind-cut.mp4",
            headers={
                "X-ClipMind-Duration-Ms": str(duration_ms),
                "X-ClipMind-Preset-Id": cut_request.preset.preset_id,
            },
            background=BackgroundTask(shutil.rmtree, temp_dir, ignore_errors=True),
        )
    except Exception:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise


async def _materialize_video_input(request: Request, temp_dir: Path) -> Path:
    content_type = request.headers.get("content-type", "").lower()
    if content_type.startswith("multipart/form-data"):
        return await _save_upload(request, temp_dir)
    if content_type.startswith("application/json"):
        payload = await request.json()
        if not isinstance(payload, dict):
            raise HTTPException(status_code=422, detail="JSON body must be an object.")

        source_url = payload.get("source_url") or payload.get("url")
        if not isinstance(source_url, str) or not source_url.strip():
            raise HTTPException(status_code=422, detail="source_url is required.")
        return _download_source_url(source_url.strip(), temp_dir)

    raise HTTPException(
        status_code=415,
        detail="Send multipart/form-data with file, or JSON with source_url.",
    )


async def _save_upload(request: Request, temp_dir: Path) -> Path:
    form = await request.form()
    upload = form.get("file")
    if not isinstance(upload, UploadFile):
        raise HTTPException(status_code=422, detail="multipart field file is required.")

    return await _save_upload_file(upload, temp_dir, "upload")


async def _save_upload_file(upload: UploadFile, temp_dir: Path, stem: str) -> Path:
    suffix = Path(upload.filename or "upload.mp4").suffix or ".mp4"
    video_path = temp_dir / f"{stem}{suffix}"
    with video_path.open("wb") as output:
        while chunk := await upload.read(1024 * 1024):
            output.write(chunk)
    await upload.close()

    return video_path


def _transcript_to_response(transcript: Transcript) -> dict[str, object]:
    return {
        "text": transcript.text,
        "segments": [
            {
                "start_ms": segment.start_ms,
                "end_ms": segment.end_ms,
                "text": segment.text,
            }
            for segment in transcript.segments
        ],
        "words": [
            {
                "start_ms": word.start_ms,
                "end_ms": word.end_ms,
                "word": word.word,
            }
            for word in transcript.words
        ],
    }


async def _parse_cut_request(request: Request, temp_dir: Path) -> CutRequest:
    content_type = request.headers.get("content-type", "").lower()
    upload: UploadFile | None = None
    source_url: str | None = None

    if content_type.startswith("multipart/form-data"):
        form = await request.form()
        upload = form.get("file")
        if not isinstance(upload, UploadFile):
            raise HTTPException(status_code=422, detail="multipart field file is required.")
        payload: Mapping[str, Any] = form
        transcript_payload = _transcript_from_form(form)
    elif content_type.startswith("application/json"):
        body = await request.json()
        if not isinstance(body, dict):
            raise HTTPException(status_code=422, detail="JSON body must be an object.")
        raw_source_url = body.get("source_url") or body.get("url")
        if not isinstance(raw_source_url, str) or not raw_source_url.strip():
            raise HTTPException(status_code=422, detail="source_url is required.")
        source_url = raw_source_url.strip()
        payload = body
        transcript_payload = body.get("transcript")
    else:
        raise HTTPException(
            status_code=415,
            detail="Send multipart/form-data with file, or JSON with source_url.",
        )

    start_ms = _required_int(payload, "start_ms")
    end_ms = _required_int(payload, "end_ms")
    trim_start_ms = _optional_int(
        payload,
        "trim_start_ms",
        ("start_trim_ms", "trim_start_offset_ms"),
    )
    trim_end_ms = _optional_int(
        payload,
        "trim_end_ms",
        ("end_trim_ms", "trim_end_offset_ms"),
    )
    preset_id = _required_text(payload, "preset_id", ("preset",))
    preset = get_caption_preset(preset_id)

    if preset is None:
        raise HTTPException(status_code=422, detail="Unknown preset_id.")
    if start_ms < 0:
        raise HTTPException(status_code=422, detail="start_ms must be non-negative.")
    if end_ms <= start_ms:
        raise HTTPException(status_code=422, detail="end_ms must be greater than start_ms.")
    if trim_start_ms < 0 or trim_end_ms < 0:
        raise HTTPException(status_code=422, detail="trim offsets must be non-negative.")
    if start_ms + trim_start_ms >= end_ms - trim_end_ms:
        raise HTTPException(status_code=422, detail="trim offsets remove the full window.")

    if upload is not None:
        video_path = await _save_upload_file(upload, temp_dir, "upload")
    elif source_url is not None:
        video_path = _download_source_url(source_url, temp_dir)
    else:
        raise HTTPException(status_code=422, detail="video source is required.")

    return CutRequest(
        video_path=video_path,
        preset=preset,
        start_ms=start_ms,
        end_ms=end_ms,
        trim_start_ms=trim_start_ms,
        trim_end_ms=trim_end_ms,
        transcript_payload=transcript_payload,
    )


def _transcript_from_form(form: Mapping[str, Any]) -> object | None:
    raw_transcript = form.get("transcript")
    if raw_transcript is None:
        return None
    if not isinstance(raw_transcript, str):
        raise HTTPException(status_code=422, detail="transcript must be JSON text.")

    try:
        return json.loads(raw_transcript)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=422, detail="transcript must be valid JSON.") from exc


def _required_int(
    payload: Mapping[str, Any],
    key: str,
    aliases: tuple[str, ...] = (),
) -> int:
    raw_value = _field_value(payload, (key, *aliases))
    if raw_value is None:
        raise HTTPException(status_code=422, detail=f"{key} is required.")
    return _parse_int(raw_value, key)


def _optional_int(
    payload: Mapping[str, Any],
    key: str,
    aliases: tuple[str, ...] = (),
) -> int:
    raw_value = _field_value(payload, (key, *aliases))
    if raw_value is None or raw_value == "":
        return 0
    return _parse_int(raw_value, key)


def _required_text(
    payload: Mapping[str, Any],
    key: str,
    aliases: tuple[str, ...] = (),
) -> str:
    raw_value = _field_value(payload, (key, *aliases))
    if not isinstance(raw_value, str) or not raw_value.strip():
        raise HTTPException(status_code=422, detail=f"{key} is required.")
    return raw_value.strip()


def _field_value(payload: Mapping[str, Any], keys: tuple[str, ...]) -> Any:
    for key in keys:
        value = payload.get(key)
        if value is not None:
            return value
    return None


def _parse_int(raw_value: Any, field_name: str) -> int:
    if isinstance(raw_value, bool):
        raise HTTPException(status_code=422, detail=f"{field_name} must be an integer.")
    try:
        return int(raw_value)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=f"{field_name} must be an integer.") from exc


def _download_source_url(source_url: str, temp_dir: Path) -> Path:
    parsed = urllib.parse.urlparse(source_url)
    if parsed.scheme not in {"http", "https"}:
        raise HTTPException(status_code=422, detail="source_url must use http or https.")

    suffix = Path(parsed.path).suffix or ".mp4"
    video_path = temp_dir / f"source{suffix}"
    request = urllib.request.Request(
        source_url,
        headers={"User-Agent": "ClipMind clip service"},
    )

    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            total = 0
            with video_path.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    if total > MAX_DOWNLOAD_BYTES:
                        raise HTTPException(status_code=413, detail="source_url is too large.")
                    output.write(chunk)
    except HTTPException:
        raise
    except urllib.error.URLError as exc:
        raise HTTPException(status_code=400, detail="Could not download source_url.") from exc

    return video_path

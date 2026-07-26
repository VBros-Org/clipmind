"""ClipMind clip service (stateless)."""

from __future__ import annotations

import secrets
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from starlette.datastructures import UploadFile

from .candidates import build_candidates
from .config import get_settings
from .transcribe import probe_video_duration_ms, transcribe_video

MAX_DOWNLOAD_BYTES = 1_000_000_000


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    get_settings()
    yield


app = FastAPI(title="ClipMind Clip Service", lifespan=lifespan)


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

    suffix = Path(upload.filename or "upload.mp4").suffix or ".mp4"
    video_path = temp_dir / f"upload{suffix}"
    with video_path.open("wb") as output:
        while chunk := await upload.read(1024 * 1024):
            output.write(chunk)
    await upload.close()

    return video_path


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

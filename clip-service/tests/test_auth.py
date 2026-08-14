from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from src import main
from src.candidates import CandidateWindow
from src.config import reset_settings_cache
from src.transcribe import Transcript, TranscriptSegment, TranscriptWord


def test_candidates_rejects_missing_or_wrong_token() -> None:
    reset_settings_cache()
    client = TestClient(main.app)

    missing = client.post(
        "/candidates",
        files={"file": ("sample.mp4", b"fake video", "video/mp4")},
    )
    wrong = client.post(
        "/candidates",
        headers={"Authorization": "Bearer wrong-token"},
        files={"file": ("sample.mp4", b"fake video", "video/mp4")},
    )

    assert missing.status_code == 401
    assert wrong.status_code == 401


def test_candidates_accepts_valid_token_with_mocked_transcription(monkeypatch) -> None:
    reset_settings_cache()
    transcript = Transcript(
        text="Wait, this is the moment.",
        segments=[
            TranscriptSegment(
                start_ms=0,
                end_ms=12_000,
                text="Wait, this is the moment.",
            )
        ],
        words=[
            TranscriptWord(start_ms=0, end_ms=400, word="Wait"),
            TranscriptWord(start_ms=400, end_ms=700, word="this"),
        ],
    )

    monkeypatch.setattr(main, "probe_video_duration_ms", lambda video_path: 20_000)
    monkeypatch.setattr(
        main,
        "transcribe_video",
        lambda video_path, api_key, work_dir, duration_ms: transcript,
    )
    monkeypatch.setattr(
        main,
        "build_candidates",
        lambda video_path, transcript, duration_ms: [
            CandidateWindow(
                start_ms=0,
                end_ms=12_000,
                transcript="Wait, this is the moment.",
                segments=transcript.segments,
                words=transcript.words,
                reasons=["transcript hook: emphasis"],
            )
        ],
    )

    client = TestClient(main.app)
    response = client.post(
        "/candidates",
        headers={"Authorization": "Bearer test-service-token"},
        files={"file": ("sample.mp4", b"fake video", "video/mp4")},
    )

    assert response.status_code == 200
    assert response.json() == {
        "duration_ms": 20_000,
        "candidates": [
            {
                "start_ms": 0,
                "end_ms": 12_000,
                "transcript": "Wait, this is the moment.",
                "segments": [
                    {
                        "start_ms": 0,
                        "end_ms": 12_000,
                        "text": "Wait, this is the moment.",
                    }
                ],
                "words": [
                    {"start_ms": 0, "end_ms": 400, "word": "Wait"},
                    {"start_ms": 400, "end_ms": 700, "word": "this"},
                ],
                "reasons": ["transcript hook: emphasis"],
            }
        ],
    }


def test_candidates_source_url_uses_deliberate_two_gb_cap(monkeypatch) -> None:
    reset_settings_cache()
    caps: list[int] = []
    transcript = Transcript(
        text="Wait, this is the moment.",
        segments=[
            TranscriptSegment(
                start_ms=0,
                end_ms=12_000,
                text="Wait, this is the moment.",
            )
        ],
        words=[],
    )

    def fake_download(source_url: str, temp_dir: Path, max_bytes: int) -> Path:
        caps.append(max_bytes)
        video_path = temp_dir / "source.mp4"
        video_path.write_bytes(b"fake video")
        return video_path

    monkeypatch.setattr(main, "_download_source_url", fake_download)
    monkeypatch.setattr(main, "probe_video_duration_ms", lambda video_path: 20_000)
    monkeypatch.setattr(
        main,
        "transcribe_video",
        lambda video_path, api_key, work_dir, duration_ms: transcript,
    )
    monkeypatch.setattr(main, "build_candidates", lambda *args: [])

    client = TestClient(main.app)
    response = client.post(
        "/candidates",
        headers={"Authorization": "Bearer test-service-token"},
        json={"source_url": "https://storage.example/large-source.mp4"},
    )

    assert response.status_code == 200
    assert caps == [main.MAX_CANDIDATES_SOURCE_BYTES]

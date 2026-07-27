from __future__ import annotations

from fastapi.testclient import TestClient

from src import main
from src.config import reset_settings_cache
from src.transcribe import Transcript, TranscriptSegment, TranscriptWord


def test_transcribe_rejects_missing_or_wrong_token() -> None:
    reset_settings_cache()
    client = TestClient(main.app)

    missing = client.post(
        "/transcribe",
        files={"file": ("sample.mp4", b"fake video", "video/mp4")},
    )
    wrong = client.post(
        "/transcribe",
        headers={"Authorization": "Bearer wrong-token"},
        files={"file": ("sample.mp4", b"fake video", "video/mp4")},
    )

    assert missing.status_code == 401
    assert wrong.status_code == 401


def test_transcribe_accepts_valid_token_with_mocked_transcription(monkeypatch) -> None:
    reset_settings_cache()
    transcript = Transcript(
        text="Wait, this is the moment.",
        segments=[
            TranscriptSegment(
                start_ms=0,
                end_ms=1_500,
                text="Wait, this is the moment.",
            )
        ],
        words=[
            TranscriptWord(start_ms=0, end_ms=400, word="Wait"),
            TranscriptWord(start_ms=400, end_ms=900, word="this"),
        ],
    )

    monkeypatch.setattr(main, "probe_video_duration_ms", lambda video_path: 2_000)
    monkeypatch.setattr(
        main,
        "transcribe_video",
        lambda video_path, api_key, work_dir, duration_ms: transcript,
    )

    client = TestClient(main.app)
    response = client.post(
        "/transcribe",
        headers={"Authorization": "Bearer test-service-token"},
        files={"file": ("sample.mp4", b"fake video", "video/mp4")},
    )

    assert response.status_code == 200
    assert response.json() == {
        "text": "Wait, this is the moment.",
        "segments": [
            {
                "start_ms": 0,
                "end_ms": 1_500,
                "text": "Wait, this is the moment.",
            }
        ],
        "words": [
            {"start_ms": 0, "end_ms": 400, "word": "Wait"},
            {"start_ms": 400, "end_ms": 900, "word": "this"},
        ],
    }

from __future__ import annotations

from fastapi.testclient import TestClient

from src import main
from src.candidates import CandidateWindow
from src.config import reset_settings_cache
from src.transcribe import Transcript, TranscriptSegment


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
        words=[],
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
                "reasons": ["transcript hook: emphasis"],
            }
        ],
    }

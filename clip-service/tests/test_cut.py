from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from src import main
from src.config import reset_settings_cache
from src.transcribe import Transcript

AUTH_HEADERS = {"Authorization": "Bearer test-service-token"}


def test_cut_rejects_missing_or_wrong_token() -> None:
    reset_settings_cache()
    client = TestClient(main.app)

    missing = client.post(
        "/cut",
        data={"start_ms": "0", "end_ms": "1000", "preset_id": "clean-bold"},
        files={"file": ("sample.mp4", b"fake video", "video/mp4")},
    )
    wrong = client.post(
        "/cut",
        headers={"Authorization": "Bearer wrong-token"},
        data={"start_ms": "0", "end_ms": "1000", "preset_id": "clean-bold"},
        files={"file": ("sample.mp4", b"fake video", "video/mp4")},
    )

    assert missing.status_code == 401
    assert wrong.status_code == 401


def test_cut_rejects_bad_window() -> None:
    reset_settings_cache()
    client = TestClient(main.app)

    response = client.post(
        "/cut",
        headers=AUTH_HEADERS,
        data={"start_ms": "1000", "end_ms": "1000", "preset_id": "clean-bold"},
        files={"file": ("sample.mp4", b"fake video", "video/mp4")},
    )

    assert response.status_code == 422


def test_cut_rejects_bad_preset() -> None:
    reset_settings_cache()
    client = TestClient(main.app)

    response = client.post(
        "/cut",
        headers=AUTH_HEADERS,
        data={"start_ms": "0", "end_ms": "1000", "preset_id": "unknown"},
        files={"file": ("sample.mp4", b"fake video", "video/mp4")},
    )

    assert response.status_code == 422


def test_cut_returns_mp4_with_supplied_transcript_without_transcribing(
    monkeypatch,
) -> None:
    reset_settings_cache()

    def fail_transcribe(*args: object, **kwargs: object) -> Transcript:
        raise AssertionError("transcribe_video should not run when transcript is supplied.")

    def fake_render(
        source_path: Path | str,
        output_path: Path,
        transcript: Transcript,
        preset: object,
        start_ms: int,
        duration_ms: int,
        work_dir: Path,
    ) -> None:
        output_path.write_bytes(b"fake mp4")

    monkeypatch.setattr(main, "probe_video_duration_ms", lambda video_path: 50_000)
    monkeypatch.setattr(main, "transcribe_video", fail_transcribe)
    monkeypatch.setattr(main, "render_cut_with_subtitles", fake_render)
    monkeypatch.setattr(main, "validate_rendered_video", lambda path, duration_ms: None)

    client = TestClient(main.app)
    response = client.post(
        "/cut",
        headers=AUTH_HEADERS,
        data={
            "start_ms": "5000",
            "end_ms": "35000",
            "preset_id": "clean-bold",
            "transcript": json.dumps(
                {
                    "text": "Wait this is the moment",
                    "segments": [
                        {
                            "start_ms": 5000,
                            "end_ms": 9000,
                            "text": "Wait this is the moment",
                        }
                    ],
                }
            ),
        },
        files={"file": ("sample.mp4", b"fake video", "video/mp4")},
    )

    assert response.status_code == 200
    assert response.content == b"fake mp4"
    assert response.headers["x-clipmind-duration-ms"] == "30000"
    assert response.headers["x-clipmind-preset-id"] == "clean-bold"


def test_cut_uses_source_url_directly_for_range_render(monkeypatch) -> None:
    reset_settings_cache()
    source_url = "https://storage.example/large-source.mp4?signature=test"
    probe_sources: list[Path | str] = []
    render_calls: list[tuple[Path | str, int, int]] = []

    def fail_download(*args: object, **kwargs: object) -> Path:
        raise AssertionError("/cut should not download JSON source_url before ffmpeg.")

    def fake_probe(source: Path | str) -> int:
        probe_sources.append(source)
        return 3_600_000

    def fake_render(
        source_path: Path | str,
        output_path: Path,
        transcript: Transcript,
        preset: object,
        start_ms: int,
        duration_ms: int,
        work_dir: Path,
    ) -> None:
        render_calls.append((source_path, start_ms, duration_ms))
        output_path.write_bytes(b"fake mp4")

    monkeypatch.setattr(main, "_download_source_url", fail_download)
    monkeypatch.setattr(main, "probe_video_duration_ms", fake_probe)
    monkeypatch.setattr(main, "render_cut_with_subtitles", fake_render)
    monkeypatch.setattr(main, "validate_rendered_video", lambda path, duration_ms: None)

    client = TestClient(main.app)
    response = client.post(
        "/cut",
        headers=AUTH_HEADERS,
        json={
            "source_url": source_url,
            "start_ms": 10_000,
            "end_ms": 40_000,
            "preset_id": "clean-bold",
            "transcript": {
                "text": "Wait this is the moment",
                "segments": [
                    {
                        "start_ms": 10_000,
                        "end_ms": 13_000,
                        "text": "Wait this is the moment",
                    }
                ],
            },
        },
    )

    assert response.status_code == 200
    assert response.content == b"fake mp4"
    assert probe_sources == [source_url]
    assert render_calls == [(source_url, 10_000, 30_000)]


def test_cut_empty_render_output_returns_distinct_5xx(monkeypatch) -> None:
    reset_settings_cache()

    def fake_render(
        source_path: Path | str,
        output_path: Path,
        transcript: Transcript,
        preset: object,
        start_ms: int,
        duration_ms: int,
        work_dir: Path,
    ) -> None:
        output_path.write_bytes(b"")

    monkeypatch.setattr(main, "probe_video_duration_ms", lambda video_path: 50_000)
    monkeypatch.setattr(main, "render_cut_with_subtitles", fake_render)

    client = TestClient(main.app, raise_server_exceptions=False)
    response = client.post(
        "/cut",
        headers=AUTH_HEADERS,
        data={
            "start_ms": "5000",
            "end_ms": "35000",
            "preset_id": "clean-bold",
            "transcript": json.dumps(
                {
                    "text": "Wait this is the moment",
                    "segments": [
                        {
                            "start_ms": 5000,
                            "end_ms": 9000,
                            "text": "Wait this is the moment",
                        }
                    ],
                }
            ),
        },
        files={"file": ("sample.mp4", b"fake video", "video/mp4")},
    )

    assert response.status_code == 500
    assert response.json()["detail"]["code"] == "empty_render_output"


def test_cut_rejects_window_over_three_minutes(monkeypatch) -> None:
    reset_settings_cache()

    def fail_probe(*args: object, **kwargs: object) -> int:
        raise AssertionError("over-cap windows should fail before probing source.")

    monkeypatch.setattr(main, "probe_video_duration_ms", fail_probe)

    client = TestClient(main.app)
    response = client.post(
        "/cut",
        headers=AUTH_HEADERS,
        json={
            "source_url": "https://storage.example/large-source.mp4",
            "start_ms": 0,
            "end_ms": 3_600_000,
            "preset_id": "clean-bold",
            "transcript": {"text": "", "segments": []},
        },
    )

    assert response.status_code == 422
    assert "180000ms" in response.json()["detail"]


def test_cut_rejects_multipart_upload_body_over_cap(monkeypatch) -> None:
    reset_settings_cache()
    monkeypatch.setattr(main, "MAX_MULTIPART_UPLOAD_BYTES", 64)

    client = TestClient(main.app)
    response = client.post(
        "/cut",
        headers=AUTH_HEADERS,
        data={"start_ms": "0", "end_ms": "1000", "preset_id": "clean-bold"},
        files={"file": ("sample.mp4", b"x" * 128, "video/mp4")},
    )

    assert response.status_code == 413
    assert response.json()["detail"]["code"] == "multipart_upload_too_large"

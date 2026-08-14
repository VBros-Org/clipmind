from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from src import main
from src.config import reset_settings_cache

AUTH_HEADERS = {"Authorization": "Bearer test-service-token"}


def test_thumbnail_rejects_missing_or_wrong_token() -> None:
    reset_settings_cache()
    client = TestClient(main.app)

    missing = client.post(
        "/thumbnail",
        data={"timestamp_ms": "0"},
        files={"file": ("sample.mp4", b"fake video", "video/mp4")},
    )
    wrong = client.post(
        "/thumbnail",
        headers={"Authorization": "Bearer wrong-token"},
        data={"timestamp_ms": "0"},
        files={"file": ("sample.mp4", b"fake video", "video/mp4")},
    )

    assert missing.status_code == 401
    assert wrong.status_code == 401


def test_thumbnail_returns_jpeg_with_mocked_ffmpeg(monkeypatch) -> None:
    reset_settings_cache()
    render_calls: list[tuple[bool, int]] = []

    def fake_render(
        source_path: Path,
        output_path: Path,
        timestamp_ms: int,
    ) -> None:
        render_calls.append((source_path.exists(), timestamp_ms))
        output_path.write_bytes(b"fake jpeg")

    monkeypatch.setattr(main, "probe_video_duration_ms", lambda video_path: 50_000)
    monkeypatch.setattr(main, "render_thumbnail_frame", fake_render)

    client = TestClient(main.app)
    response = client.post(
        "/thumbnail",
        headers=AUTH_HEADERS,
        data={"timestamp_ms": "12000"},
        files={"file": ("sample.mp4", b"fake video", "video/mp4")},
    )

    assert response.status_code == 200
    assert response.content == b"fake jpeg"
    assert response.headers["content-type"] == "image/jpeg"
    assert response.headers["x-clipmind-timestamp-ms"] == "12000"
    assert len(render_calls) == 1
    assert render_calls[0][0] is True
    assert render_calls[0][1] == 12_000


def test_thumbnail_uses_source_url_directly(monkeypatch) -> None:
    reset_settings_cache()
    source_url = "https://storage.example/large-source.mp4?signature=test"
    render_calls: list[tuple[Path | str, int]] = []

    def fail_download(*args: object, **kwargs: object) -> Path:
        raise AssertionError("/thumbnail should not download JSON source_url first.")

    def fake_render(
        source_path: Path | str,
        output_path: Path,
        timestamp_ms: int,
    ) -> None:
        render_calls.append((source_path, timestamp_ms))
        output_path.write_bytes(b"fake jpeg")

    monkeypatch.setattr(main, "_download_source_url", fail_download)
    monkeypatch.setattr(main, "probe_video_duration_ms", lambda video_path: 50_000)
    monkeypatch.setattr(main, "render_thumbnail_frame", fake_render)

    client = TestClient(main.app)
    response = client.post(
        "/thumbnail",
        headers=AUTH_HEADERS,
        json={"source_url": source_url, "timestamp_ms": 12_000},
    )

    assert response.status_code == 200
    assert response.content == b"fake jpeg"
    assert render_calls == [(source_url, 12_000)]

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from src import main, youtube
from src.config import reset_settings_cache
from src.transcribe import Transcript, TranscriptSegment
from src.youtube import (
    YoutubeBlockedError,
    YoutubeDurationError,
    YoutubeValidationError,
    YoutubeVideo,
    download_youtube_audio,
    normalize_youtube_channel_url,
)

AUTH_HEADERS = {"Authorization": "Bearer test-service-token"}


def test_channel_url_validation_accepts_youtube_handles_and_rejects_other_platforms() -> None:
    assert (
        normalize_youtube_channel_url("@MrBeast")
        == "https://www.youtube.com/@MrBeast/videos"
    )
    assert (
        normalize_youtube_channel_url("youtube.com/@MrBeast")
        == "https://www.youtube.com/@MrBeast/videos"
    )

    with pytest.raises(YoutubeValidationError):
        normalize_youtube_channel_url("https://www.tiktok.com/@mrbeast")


def test_channel_list_returns_top_ten_videos(monkeypatch) -> None:
    reset_settings_cache()

    def fake_list(channel_url: str, limit: int) -> list[YoutubeVideo]:
        assert channel_url == "@MrBeast"
        assert limit == 10
        return [
            YoutubeVideo(
                video_id="video-1",
                title="First upload",
                duration_s=240,
                url="https://www.youtube.com/watch?v=video-1",
            )
        ]

    monkeypatch.setattr(main, "list_youtube_channel_uploads", fake_list)

    client = TestClient(main.app)
    response = client.post(
        "/channel-list",
        headers=AUTH_HEADERS,
        json={"channel_url": "@MrBeast"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "videos": [
            {
                "video_id": "video-1",
                "title": "First upload",
                "duration_s": 240,
                "url": "https://www.youtube.com/watch?v=video-1",
            }
        ]
    }


def test_transcribe_remote_caps_duration_at_twenty_minutes(monkeypatch) -> None:
    reset_settings_cache()
    caps: list[int] = []

    def fake_download(video_url: str, temp_dir: Path, max_duration_s: int) -> Path:
        assert video_url == "https://www.youtube.com/watch?v=long"
        assert temp_dir.exists()
        caps.append(max_duration_s)
        raise YoutubeDurationError(duration_s=1_500, max_duration_s=max_duration_s)

    monkeypatch.setattr(main, "download_youtube_audio", fake_download)

    client = TestClient(main.app)
    response = client.post(
        "/transcribe-remote",
        headers=AUTH_HEADERS,
        json={
            "video_url": "https://www.youtube.com/watch?v=long",
            "max_duration_s": 9_999,
        },
    )

    assert response.status_code == 422
    assert caps == [1_200]
    assert response.json()["detail"]["code"] == "duration_over_cap"


def test_transcribe_remote_surfaces_youtube_block(monkeypatch) -> None:
    reset_settings_cache()

    def fake_download(video_url: str, temp_dir: Path, max_duration_s: int) -> Path:
        raise YoutubeBlockedError("Sign in to confirm you're not a bot.")

    monkeypatch.setattr(main, "download_youtube_audio", fake_download)

    client = TestClient(main.app)
    response = client.post(
        "/transcribe-remote",
        headers=AUTH_HEADERS,
        json={"video_url": "https://www.youtube.com/watch?v=blocked"},
    )

    assert response.status_code == 502
    assert response.json()["detail"] == {
        "code": "yt_blocked",
        "message": "YouTube blocked this server request.",
    }


def test_transcribe_remote_cleans_temp_files_after_transcription(monkeypatch) -> None:
    reset_settings_cache()
    temp_dirs: list[Path] = []
    transcript = Transcript(
        text="Wait, this is the moment.",
        segments=[
            TranscriptSegment(
                start_ms=0,
                end_ms=2_000,
                text="Wait, this is the moment.",
            )
        ],
        words=[],
    )

    def fake_download(video_url: str, temp_dir: Path, max_duration_s: int) -> Path:
        temp_dirs.append(temp_dir)
        audio_path = temp_dir / "remote.m4a"
        audio_path.write_bytes(b"fake audio")
        return audio_path

    monkeypatch.setattr(main, "download_youtube_audio", fake_download)
    monkeypatch.setattr(main, "probe_video_duration_ms", lambda video_path: 2_000)
    monkeypatch.setattr(
        main,
        "transcribe_video",
        lambda video_path, api_key, work_dir, duration_ms: transcript,
    )

    client = TestClient(main.app)
    response = client.post(
        "/transcribe-remote",
        headers=AUTH_HEADERS,
        json={"video_url": "https://www.youtube.com/watch?v=short"},
    )

    assert response.status_code == 200
    assert response.json()["text"] == "Wait, this is the moment."
    assert temp_dirs
    assert not temp_dirs[0].exists()


@pytest.mark.parametrize(
    ("metadata", "message"),
    [
        (
            {"live_status": "is_live", "duration": 600},
            "Live YouTube URLs are not supported.",
        ),
        (
            {"live_status": "not_live"},
            "YouTube video duration is unavailable.",
        ),
    ],
)
def test_download_youtube_audio_rejects_live_or_durationless_before_download(
    monkeypatch,
    tmp_path: Path,
    metadata: dict[str, object],
    message: str,
) -> None:
    calls: list[bool] = []

    def fake_extract_info(
        url: str,
        options: dict[str, object],
        download: bool,
    ) -> dict[str, object]:
        calls.append(download)
        if download:
            raise AssertionError("yt-dlp download should not start.")
        return metadata

    monkeypatch.setattr(youtube, "_extract_info", fake_extract_info)

    with pytest.raises(YoutubeValidationError, match=message):
        download_youtube_audio(
            "https://www.youtube.com/watch?v=video-id",
            tmp_path,
            1_200,
        )

    assert calls == [False]

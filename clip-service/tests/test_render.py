from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from src import render
from src.presets import get_caption_preset
from src.transcribe import Transcript, TranscriptSegment


def test_render_cut_uses_seeked_url_input(monkeypatch, tmp_path: Path) -> None:
    commands: list[list[str]] = []
    source_url = "https://storage.example/source.mp4?signature=test"
    preset = get_caption_preset("clean-bold")
    assert preset is not None

    def fake_run(
        command: list[str],
        check: bool,
        capture_output: bool,
        text: bool,
    ) -> subprocess.CompletedProcess[str]:
        commands.append(command)
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr(render.subprocess, "run", fake_run)

    render.render_cut_with_subtitles(
        source_url,
        tmp_path / "out.mp4",
        Transcript(
            text="Wait this is the moment",
            segments=[
                TranscriptSegment(
                    start_ms=10_000,
                    end_ms=13_000,
                    text="Wait this is the moment",
                )
            ],
            words=[],
        ),
        preset,
        10_000,
        30_000,
        tmp_path,
    )

    assert len(commands) == 1
    _assert_seeked_input(commands[0], source_url, "10.000", "40.000")
    assert "-t" not in commands[0]


def test_render_thumbnail_uses_seeked_url_input(monkeypatch, tmp_path: Path) -> None:
    commands: list[list[str]] = []
    source_url = "https://storage.example/source.mp4?signature=test"

    def fake_run(
        command: list[str],
        check: bool,
        capture_output: bool,
        text: bool,
    ) -> subprocess.CompletedProcess[str]:
        commands.append(command)
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr(render.subprocess, "run", fake_run)

    render.render_thumbnail_frame(source_url, tmp_path / "thumb.jpg", 12_000)

    assert len(commands) == 1
    _assert_seeked_input(commands[0], source_url, "12.000", "13.000")


@pytest.mark.parametrize(
    ("probe_payload", "code"),
    [
        (
            {
                "streams": [{"codec_type": "audio"}],
                "format": {"duration": "30.0"},
            },
            "render_missing_video_stream",
        ),
        (
            {
                "streams": [{"codec_type": "video"}],
                "format": {"duration": "5.0"},
            },
            "render_duration_mismatch",
        ),
    ],
)
def test_validate_rendered_video_requires_video_stream_and_sane_duration(
    monkeypatch,
    tmp_path: Path,
    probe_payload: dict[str, object],
    code: str,
) -> None:
    output_path = tmp_path / "out.mp4"
    output_path.write_bytes(b"not empty")

    def fake_run(
        command: list[str],
        check: bool,
        capture_output: bool,
        text: bool,
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(
            command,
            0,
            stdout=json.dumps(probe_payload),
            stderr="",
        )

    monkeypatch.setattr(render.subprocess, "run", fake_run)

    with pytest.raises(render.RenderOutputValidationError) as error:
        render.validate_rendered_video(output_path, 30_000)

    assert error.value.code == code


def _assert_seeked_input(
    command: list[str],
    source_url: str,
    expected_start: str,
    expected_end: str,
) -> None:
    input_index = command.index("-i")
    ss_index = command.index("-ss")
    to_index = command.index("-to")
    assert ss_index < input_index
    assert to_index < input_index
    assert command[ss_index + 1] == expected_start
    assert command[to_index + 1] == expected_end
    assert command[input_index + 1] == source_url

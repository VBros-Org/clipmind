from __future__ import annotations

from pathlib import Path

from src.presets import CAPTION_PRESETS
from src.subtitles import generate_ass, transcript_for_cut
from src.transcribe import Transcript, TranscriptSegment, TranscriptWord

FIXTURES_DIR = Path(__file__).parent / "fixtures"


def test_static_ass_wraps_lines_without_karaoke_tags() -> None:
    transcript = Transcript(
        text="One two three four five six.",
        segments=[
            TranscriptSegment(
                start_ms=0,
                end_ms=4_000,
                text="One two three four five six.",
            )
        ],
        words=[],
    )

    ass = generate_ass(transcript, CAPTION_PRESETS["clean-bold"], 4_000)

    assert "One two three four\\Nfive six." in ass
    assert r"{\k" not in ass


def test_karaoke_ass_uses_word_timing_tags_and_wraps_lines() -> None:
    transcript = Transcript(
        text="One two three four five",
        segments=[
            TranscriptSegment(
                start_ms=0,
                end_ms=1_000,
                text="One two three four five",
            )
        ],
        words=[
            TranscriptWord(start_ms=0, end_ms=200, word="One"),
            TranscriptWord(start_ms=200, end_ms=400, word="two"),
            TranscriptWord(start_ms=400, end_ms=600, word="three"),
            TranscriptWord(start_ms=600, end_ms=800, word="four"),
            TranscriptWord(start_ms=800, end_ms=1_000, word="five"),
        ],
    )

    ass = generate_ass(transcript, CAPTION_PRESETS["karaoke"], 1_000)

    assert r"{\k20}One" in ass
    assert r"{\k20}five" in ass
    assert r"four\N{\k20}five" in ass


def test_karaoke_ass_matches_timed_fixture() -> None:
    transcript = Transcript(
        text="Wait this lands now",
        segments=[
            TranscriptSegment(
                start_ms=5_000,
                end_ms=6_200,
                text="Wait this lands now",
            )
        ],
        words=[
            TranscriptWord(start_ms=5_000, end_ms=5_250, word="Wait"),
            TranscriptWord(start_ms=5_250, end_ms=5_700, word="this"),
            TranscriptWord(start_ms=5_700, end_ms=5_950, word="lands"),
            TranscriptWord(start_ms=5_950, end_ms=6_200, word="now"),
        ],
    )
    cut = transcript_for_cut(transcript, 5_000, 7_000)

    ass = generate_ass(cut, CAPTION_PRESETS["karaoke"], 2_000)

    assert ass == (FIXTURES_DIR / "karaoke_timed.ass").read_text(encoding="utf-8")


def test_transcript_for_cut_shifts_absolute_timestamps() -> None:
    transcript = Transcript(
        text="Wait this is it",
        segments=[
            TranscriptSegment(start_ms=5_000, end_ms=7_000, text="Wait this is it")
        ],
        words=[
            TranscriptWord(start_ms=5_200, end_ms=5_500, word="Wait"),
            TranscriptWord(start_ms=5_500, end_ms=5_800, word="this"),
        ],
    )

    cut = transcript_for_cut(transcript, 5_000, 8_000)

    assert cut.segments[0].start_ms == 0
    assert cut.segments[0].end_ms == 2_000
    assert cut.words[0].start_ms == 200

from __future__ import annotations

from pathlib import Path

from src import candidates
from src.transcribe import Transcript, TranscriptSegment, TranscriptWord


def test_hook_heuristic_flags_questions_exclamations_emphasis_and_topic_shifts() -> None:
    assert "transcript hook: question" in candidates.hook_reasons(
        "Why is this happening?"
    )
    assert "transcript hook: exclamation" in candidates.hook_reasons(
        "This is impossible!"
    )
    assert "transcript hook: emphasis" in candidates.hook_reasons(
        "Wait, watch this angle."
    )
    assert "transcript hook: topic shift" in candidates.hook_reasons(
        "But then the run changes."
    )
    assert not candidates.looks_like_hook("The character walks forward.")


def test_dense_monologue_produces_multiple_clip_sized_windows(monkeypatch) -> None:
    monkeypatch.setattr(candidates, "audio_energy_anchors", no_audio_anchors)
    transcript = synthetic_monologue(
        duration_ms=300_000,
        segment_ms=5_000,
        hook_starts_ms={0, 40_000, 80_000, 120_000, 160_000, 200_000, 240_000},
    )

    windows = candidates.build_candidates(Path("unused.mp4"), transcript, 300_000)

    assert len(windows) > 1
    assert len(windows) <= candidates.MAX_CANDIDATES
    assert [window.start_ms for window in windows] == sorted(
        window.start_ms for window in windows
    )
    assert all(
        candidates.MIN_CLIP_MS <= window.end_ms - window.start_ms <= candidates.MAX_CLIP_MS
        for window in windows
    )
    assert {window.start_ms for window in windows} != {0}


def test_window_never_spans_more_than_75_percent_of_source_over_30s(
    monkeypatch,
) -> None:
    monkeypatch.setattr(candidates, "audio_energy_anchors", no_audio_anchors)
    transcript = transcript_from_segments(
        [
            TranscriptSegment(
                start_ms=0,
                end_ms=55_000,
                text="Why this whole thought used to become one full source clip?",
            )
        ]
    )

    windows = candidates.build_candidates(Path("unused.mp4"), transcript, 55_000)

    assert len(windows) == 1
    assert windows[0].end_ms - windows[0].start_ms <= int(55_000 * 0.75)


def test_under_30s_source_returns_one_whole_source_window(monkeypatch) -> None:
    monkeypatch.setattr(candidates, "audio_energy_anchors", no_audio_anchors)
    transcript = synthetic_monologue(
        duration_ms=25_000,
        segment_ms=5_000,
        hook_starts_ms={0, 5_000, 10_000},
    )

    windows = candidates.build_candidates(Path("unused.mp4"), transcript, 25_000)

    assert len(windows) == 1
    assert windows[0].start_ms == 0
    assert windows[0].end_ms == 25_000


def test_candidates_carry_windowed_segments_and_words(monkeypatch) -> None:
    monkeypatch.setattr(candidates, "audio_energy_anchors", no_audio_anchors)
    transcript = Transcript(
        text="Why this timing matters?",
        segments=[
            TranscriptSegment(
                start_ms=10_000,
                end_ms=15_000,
                text="Why this timing matters?",
            ),
        ],
        words=[
            TranscriptWord(start_ms=10_100, end_ms=10_400, word="Why"),
            TranscriptWord(start_ms=10_400, end_ms=10_800, word="this"),
        ],
    )

    windows = candidates.build_candidates(Path("unused.mp4"), transcript, 60_000)

    assert len(windows) == 1
    assert windows[0].segments == [transcript.segments[0]]
    assert windows[0].words == transcript.words
    assert windows[0].to_response()["segments"] == [
        {
            "start_ms": 10_000,
            "end_ms": 15_000,
            "text": "Why this timing matters?",
        }
    ]
    assert windows[0].to_response()["words"] == [
        {"start_ms": 10_100, "end_ms": 10_400, "word": "Why"},
        {"start_ms": 10_400, "end_ms": 10_800, "word": "this"},
    ]


def test_scored_spread_selection_keeps_strong_late_window(monkeypatch) -> None:
    def late_spike(
        _video_path: Path,
        _transcript: Transcript,
    ) -> list[candidates.CandidateAnchor]:
        return [
            candidates.CandidateAnchor(
                kind="energy",
                segment_index=0,
                anchor_ms=110_000,
                reasons=["audio energy: spike above rolling baseline"],
                spike_delta_lufs=24.0,
            )
        ]

    monkeypatch.setattr(candidates, "audio_energy_anchors", late_spike)
    transcript = synthetic_monologue(
        duration_ms=104_000,
        segment_ms=8_000,
        hook_starts_ms=set(range(0, 104_000, 8_000)),
    )

    windows = candidates.build_candidates(Path("unused.mp4"), transcript, 140_000)

    assert len(windows) == candidates.MAX_CANDIDATES
    assert any(window.anchor_ms == 110_000 for window in windows)
    assert max(window.anchor_ms for window in windows) == 110_000
    assert [window.anchor_ms for window in windows] != list(
        range(0, candidates.MAX_CANDIDATES * 8_000, 8_000)
    )


def test_spike_without_transcript_segment_produces_candidate(monkeypatch) -> None:
    monkeypatch.setattr(
        candidates,
        "loudness_samples",
        lambda _video_path: loudness_fixture_with_spike(3_000),
    )

    windows = candidates.build_candidates(
        Path("unused.mp4"),
        Transcript(text="", segments=[], words=[]),
        60_000,
    )

    assert len(windows) == 1
    assert windows[0].anchor_kind == "energy"
    assert windows[0].start_ms == 3_000
    assert windows[0].end_ms == 23_000
    assert windows[0].transcript == ""


def test_spike_between_segments_anchors_to_spike_not_following_segment(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        candidates,
        "loudness_samples",
        lambda _video_path: loudness_fixture_with_spike(5_000),
    )
    transcript = transcript_from_segments(
        [
            TranscriptSegment(0, 1_000, "The setup is calm."),
            TranscriptSegment(10_000, 12_000, "The reaction lands later."),
        ]
    )

    windows = candidates.build_candidates(Path("unused.mp4"), transcript, 60_000)

    assert len(windows) == 1
    assert windows[0].anchor_kind == "energy"
    assert windows[0].start_ms == 5_000


def test_iou_dedupe_keeps_stronger_anchor() -> None:
    deduped = candidates.dedupe_overlapping_windows(
        [
            candidates.CandidateWindow(
                0,
                30_000,
                reasons=["audio energy: spike above rolling baseline"],
                anchor_kind="energy",
                anchor_ms=0,
            ),
            candidates.CandidateWindow(
                2_000,
                32_000,
                reasons=["transcript hook: question"],
                anchor_kind="hook",
                anchor_ms=2_000,
            ),
        ],
        duration_ms=80_000,
    )

    assert len(deduped) == 1
    assert deduped[0].reasons == ["transcript hook: question"]
    assert deduped[0].anchor_kind == "hook"


def test_min_and_max_bounds_are_enforced(monkeypatch) -> None:
    monkeypatch.setattr(candidates, "audio_energy_anchors", no_audio_anchors)

    short_tail = transcript_from_segments(
        [
            TranscriptSegment(0, 5_000, "The setup is calm."),
            TranscriptSegment(65_000, 68_000, "Why does the ending suddenly work?"),
        ]
    )
    min_windows = candidates.build_candidates(Path("unused.mp4"), short_tail, 70_000)

    assert len(min_windows) == 1
    assert min_windows[0].end_ms - min_windows[0].start_ms >= candidates.MIN_CLIP_MS

    long_segment = transcript_from_segments(
        [
            TranscriptSegment(
                0,
                100_000,
                "Why this single long sentence must still be bounded?",
            )
        ]
    )
    max_windows = candidates.build_candidates(Path("unused.mp4"), long_segment, 120_000)

    assert len(max_windows) == 1
    assert max_windows[0].end_ms - max_windows[0].start_ms == candidates.MAX_CLIP_MS


def no_audio_anchors(
    _video_path: Path,
    _transcript: Transcript,
) -> list[candidates.CandidateAnchor]:
    return []


def loudness_fixture_with_spike(spike_ms: int) -> list[candidates.LoudnessSample]:
    baseline_times = range(max(0, spike_ms - 3_000), spike_ms, 500)
    return [
        *[
            candidates.LoudnessSample(time_ms=time_ms, momentary_lufs=-50.0)
            for time_ms in baseline_times
        ],
        candidates.LoudnessSample(time_ms=spike_ms, momentary_lufs=-30.0),
    ]


def synthetic_monologue(
    duration_ms: int,
    segment_ms: int,
    hook_starts_ms: set[int],
) -> Transcript:
    segments: list[TranscriptSegment] = []
    for start_ms in range(0, duration_ms, segment_ms):
        end_ms = min(duration_ms, start_ms + segment_ms)
        if start_ms in hook_starts_ms:
            text = f"Why this moment at {start_ms // 1000} seconds matters?"
        else:
            text = f"This is steady context at {start_ms // 1000} seconds."
        segments.append(
            TranscriptSegment(start_ms=start_ms, end_ms=end_ms, text=text)
        )

    return transcript_from_segments(segments)


def transcript_from_segments(segments: list[TranscriptSegment]) -> Transcript:
    return Transcript(
        text=" ".join(segment.text for segment in segments),
        segments=segments,
        words=[],
    )

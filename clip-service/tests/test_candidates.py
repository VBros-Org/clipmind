from __future__ import annotations

from src.candidates import (
    MAX_CLIP_MS,
    CandidateWindow,
    hook_reasons,
    looks_like_hook,
    merge_overlapping_windows,
)


def test_hook_heuristic_flags_questions_exclamations_emphasis_and_topic_shifts() -> None:
    assert "transcript hook: question" in hook_reasons("Why is this happening?")
    assert "transcript hook: exclamation" in hook_reasons("This is impossible!")
    assert "transcript hook: emphasis" in hook_reasons("Wait, watch this angle.")
    assert "transcript hook: topic shift" in hook_reasons("But then the run changes.")
    assert not looks_like_hook("The character walks forward.")


def test_merge_overlapping_windows_combines_reasons_and_keeps_separate_gaps() -> None:
    merged = merge_overlapping_windows(
        [
            CandidateWindow(1_000, 15_000, reasons=["transcript hook: question"]),
            CandidateWindow(
                14_000,
                26_000,
                reasons=["audio energy: spike above rolling baseline"],
            ),
            CandidateWindow(50_000, 62_000, reasons=["transcript hook: emphasis"]),
        ],
        duration_ms=70_000,
        gap_ms=0,
    )

    assert len(merged) == 2
    assert merged[0].start_ms == 1_000
    assert merged[0].end_ms == 26_000
    assert merged[0].reasons == [
        "transcript hook: question",
        "audio energy: spike above rolling baseline",
    ]
    assert merged[1].start_ms == 50_000
    assert merged[1].end_ms == 62_000


def test_merge_overlapping_windows_clamps_to_max_clip_length() -> None:
    merged = merge_overlapping_windows(
        [CandidateWindow(0, 120_000, reasons=["transcript hook: question"])],
        duration_ms=120_000,
    )

    assert len(merged) == 1
    assert merged[0].end_ms - merged[0].start_ms == MAX_CLIP_MS

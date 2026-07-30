"""Candidate window extraction from transcript hooks and audio energy."""

from __future__ import annotations

import re
import statistics
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from .transcribe import Transcript, TranscriptSegment

MIN_CLIP_MS = 10_000
TARGET_MIN_CLIP_MS = 20_000
TARGET_MAX_CLIP_MS = 45_000
MAX_CLIP_MS = 60_000
MAX_CANDIDATES = 8
WHOLE_SOURCE_MAX_MS = 30_000
MAX_SOURCE_SPAN_RATIO = 0.75
IOU_DEDUPE_THRESHOLD = 0.60
MID_THOUGHT_GAP_MS = 1_500

QUESTION_STARTERS = {
    "what",
    "why",
    "how",
    "when",
    "where",
    "who",
    "can",
    "could",
    "do",
    "does",
    "did",
    "is",
    "are",
    "should",
    "would",
    "will",
}
EMPHASIS_WORDS = {
    "actually",
    "always",
    "best",
    "crazy",
    "huge",
    "insane",
    "important",
    "literally",
    "massive",
    "never",
    "ridiculous",
    "secret",
    "wait",
    "watch",
    "wild",
    "worst",
}
TOPIC_SHIFT_PREFIXES = (
    "but ",
    "here is ",
    "here's ",
    "now ",
    "so ",
    "the thing is ",
    "then ",
)
CONTINUATION_STARTERS = {
    "also",
    "and",
    "as",
    "because",
    "but",
    "if",
    "like",
    "or",
    "so",
    "that",
    "then",
    "when",
    "while",
    "which",
}
TERMINAL_PUNCTUATION = (".", "?", "!")
TOKEN_RE = re.compile(r"[a-z0-9']+")
LOUDNESS_RE = re.compile(
    r"t:\s*(?P<time>\d+(?:\.\d+)?)\s+.*?\bM:\s*(?P<momentary>-?\d+(?:\.\d+)?)"
)


@dataclass
class CandidateWindow:
    start_ms: int
    end_ms: int
    transcript: str = ""
    reasons: list[str] = field(default_factory=list)
    anchor_kind: str = "hook"
    anchor_ms: int = 0

    def to_response(self) -> dict[str, object]:
        return {
            "start_ms": self.start_ms,
            "end_ms": self.end_ms,
            "transcript": self.transcript,
            "reasons": self.reasons,
        }


@dataclass(frozen=True)
class CandidateAnchor:
    kind: str
    segment_index: int
    anchor_ms: int
    reasons: list[str]


@dataclass(frozen=True)
class LoudnessSample:
    time_ms: int
    momentary_lufs: float


def build_candidates(
    video_path: Path,
    transcript: Transcript,
    duration_ms: int,
) -> list[CandidateWindow]:
    if _allows_whole_source_candidate(duration_ms) and _has_transcript(transcript):
        return [_whole_source_candidate(transcript, duration_ms)]

    anchors: list[CandidateAnchor] = []
    anchors.extend(transcript_hook_anchors(transcript))
    anchors.extend(audio_energy_anchors(video_path, transcript))

    raw_windows = [
        anchor_window(anchor, transcript, duration_ms)
        for anchor in anchors
        if transcript.segments
    ]

    deduped = dedupe_overlapping_windows(raw_windows, duration_ms)
    for window in deduped:
        window.transcript = transcript_for_window(transcript, window.start_ms, window.end_ms)

    candidates = [window for window in deduped if window.transcript]
    if not candidates and transcript.segments:
        candidates = [_opening_transcript_candidate(transcript, duration_ms)]

    return candidates[:MAX_CANDIDATES]


def transcript_hook_anchors(transcript: Transcript) -> list[CandidateAnchor]:
    anchors: list[CandidateAnchor] = []

    for index, segment in enumerate(transcript.segments):
        reasons = hook_reasons(segment.text)
        if not reasons:
            continue

        anchors.append(
            CandidateAnchor(
                kind="hook",
                segment_index=index,
                anchor_ms=segment.start_ms,
                reasons=reasons,
            )
        )

    return anchors


def transcript_hook_windows(
    transcript: Transcript,
    duration_ms: int,
) -> list[CandidateWindow]:
    return [
        anchor_window(anchor, transcript, duration_ms)
        for anchor in transcript_hook_anchors(transcript)
    ]


def hook_reasons(text: str) -> list[str]:
    """Simple hook heuristic for early speech-first candidates.

    We flag segment starts that behave like social-video hooks: direct questions,
    exclamations, emphasis words near the start, or obvious topic-shift phrases.
    This is intentionally deterministic and broad. The Mind ranks taste later.
    """
    normalized = _normalize_text(text)
    if not normalized:
        return []

    tokens = TOKEN_RE.findall(normalized)
    first_token = tokens[0] if tokens else ""
    first_tokens = set(tokens[:8])
    reasons: list[str] = []

    if "?" in text or first_token in QUESTION_STARTERS:
        reasons.append("transcript hook: question")
    if "!" in text:
        reasons.append("transcript hook: exclamation")
    if first_tokens & EMPHASIS_WORDS:
        reasons.append("transcript hook: emphasis")
    if normalized.startswith(TOPIC_SHIFT_PREFIXES):
        reasons.append("transcript hook: topic shift")

    return reasons


def looks_like_hook(text: str) -> bool:
    return bool(hook_reasons(text))


def audio_energy_anchors(
    video_path: Path,
    transcript: Transcript,
) -> list[CandidateAnchor]:
    if not transcript.segments:
        return []

    samples = loudness_samples(video_path)
    spikes = energy_spike_groups(samples)
    anchors: list[CandidateAnchor] = []

    for group in spikes:
        strongest_sample = max(group, key=lambda sample: sample.momentary_lufs)
        anchors.append(
            CandidateAnchor(
                kind="energy",
                segment_index=_segment_index_for_time(
                    transcript.segments,
                    strongest_sample.time_ms,
                ),
                anchor_ms=strongest_sample.time_ms,
                reasons=["audio energy: spike above rolling baseline"],
            )
        )

    return anchors


def audio_energy_windows(
    video_path: Path,
    transcript: Transcript,
    duration_ms: int,
) -> list[CandidateWindow]:
    return [
        anchor_window(anchor, transcript, duration_ms)
        for anchor in audio_energy_anchors(video_path, transcript)
    ]


def loudness_samples(video_path: Path) -> list[LoudnessSample]:
    result = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "verbose",
            "-nostats",
            "-i",
            str(video_path),
            "-vn",
            "-filter:a",
            "ebur128=framelog=verbose",
            "-f",
            "null",
            "-",
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        output = (result.stderr or result.stdout or "").strip()
        detail = f": {output[-1200:]}" if output else ""
        raise RuntimeError(f"ffmpeg loudness analysis failed{detail}")

    samples: list[LoudnessSample] = []
    for match in LOUDNESS_RE.finditer(result.stderr):
        time_ms = int(round(float(match.group("time")) * 1000))
        momentary = float(match.group("momentary"))
        samples.append(LoudnessSample(time_ms=time_ms, momentary_lufs=momentary))

    return samples


def energy_spike_groups(samples: list[LoudnessSample]) -> list[list[LoudnessSample]]:
    flagged: list[LoudnessSample] = []
    for index, sample in enumerate(samples):
        if sample.momentary_lufs <= -100:
            continue

        prior = [
            previous.momentary_lufs
            for previous in samples[:index]
            if previous.momentary_lufs > -100
            and 500 <= sample.time_ms - previous.time_ms <= 5_000
        ]
        if len(prior) < 5:
            continue

        baseline = statistics.median(prior)
        if sample.momentary_lufs - baseline >= 6.0 and sample.momentary_lufs > -38:
            flagged.append(sample)

    groups: list[list[LoudnessSample]] = []
    for sample in flagged:
        if groups and sample.time_ms - groups[-1][-1].time_ms <= 700:
            groups[-1].append(sample)
        else:
            groups.append([sample])

    return groups


def anchor_window(
    anchor: CandidateAnchor,
    transcript: Transcript,
    duration_ms: int,
) -> CandidateWindow:
    if not transcript.segments:
        return CandidateWindow(0, 0, reasons=anchor.reasons)

    segment_index = max(0, min(anchor.segment_index, len(transcript.segments) - 1))
    start_index = segment_index
    end_index = segment_index
    start_ms = transcript.segments[start_index].start_ms
    end_ms = max(start_ms, transcript.segments[end_index].end_ms)

    while (
        end_ms - start_ms < TARGET_MIN_CLIP_MS
        and end_index + 1 < len(transcript.segments)
    ):
        end_index += 1
        end_ms = max(end_ms, transcript.segments[end_index].end_ms)

    if _should_extend_backward_one_segment(
        anchor,
        transcript.segments,
        start_index,
        end_ms,
        duration_ms,
    ):
        start_index -= 1
        start_ms = transcript.segments[start_index].start_ms

    return _clamp_window(
        CandidateWindow(
            start_ms=start_ms,
            end_ms=end_ms,
            reasons=anchor.reasons,
            anchor_kind=anchor.kind,
            anchor_ms=anchor.anchor_ms,
        ),
        duration_ms,
    )


def dedupe_overlapping_windows(
    windows: list[CandidateWindow],
    duration_ms: int,
    iou_threshold: float = IOU_DEDUPE_THRESHOLD,
) -> list[CandidateWindow]:
    prepared = [
        _clamp_window(window, duration_ms)
        for window in windows
        if window.end_ms > window.start_ms
    ]
    prepared.sort(key=_anchor_strength_key)

    selected: list[CandidateWindow] = []
    for window in prepared:
        if any(
            _window_iou(window, selected_window) > iou_threshold
            for selected_window in selected
        ):
            continue

        selected.append(window)

    selected.sort(key=lambda window: (window.start_ms, window.end_ms, window.anchor_ms))
    return selected


def merge_overlapping_windows(
    windows: list[CandidateWindow],
    duration_ms: int,
    gap_ms: int = 0,
) -> list[CandidateWindow]:
    _ = gap_ms
    return dedupe_overlapping_windows(windows, duration_ms)


def transcript_for_window(transcript: Transcript, start_ms: int, end_ms: int) -> str:
    parts = [
        segment.text.strip()
        for segment in transcript.segments
        if segment.text.strip() and _overlaps(segment, start_ms, end_ms)
    ]
    if not parts and start_ms == 0 and transcript.text.strip():
        parts = [transcript.text.strip()]
    return _squash_whitespace(" ".join(parts))


def _opening_transcript_candidate(
    transcript: Transcript,
    duration_ms: int,
) -> CandidateWindow:
    window = anchor_window(
        CandidateAnchor(
            kind="hook",
            segment_index=0,
            anchor_ms=transcript.segments[0].start_ms,
            reasons=["transcript hook: opening"],
        ),
        transcript,
        duration_ms,
    )
    window.transcript = transcript_for_window(transcript, window.start_ms, window.end_ms)
    return window


def _whole_source_candidate(
    transcript: Transcript,
    duration_ms: int,
) -> CandidateWindow:
    window = CandidateWindow(
        start_ms=0,
        end_ms=max(0, duration_ms),
        reasons=["source: under 30s whole video"],
        anchor_kind="source",
        anchor_ms=0,
    )
    window.transcript = transcript_for_window(transcript, window.start_ms, window.end_ms)
    return window


def _clamp_window(window: CandidateWindow, duration_ms: int) -> CandidateWindow:
    if duration_ms <= 0:
        return CandidateWindow(
            0,
            0,
            transcript=window.transcript,
            reasons=window.reasons,
            anchor_kind=window.anchor_kind,
            anchor_ms=window.anchor_ms,
        )

    start_ms = max(0, min(window.start_ms, duration_ms))
    end_ms = max(start_ms, min(window.end_ms, duration_ms))
    length_ms = end_ms - start_ms

    max_length = min(_max_window_length_ms(duration_ms), duration_ms)
    min_length = min(MIN_CLIP_MS, duration_ms, max_length)

    if length_ms > max_length:
        end_ms = min(duration_ms, start_ms + max_length)
        start_ms = max(0, end_ms - max_length)
        length_ms = end_ms - start_ms

    if length_ms < min_length:
        missing = min_length - length_ms
        grow_left = min(start_ms, missing // 2)
        start_ms -= grow_left
        end_ms = min(duration_ms, end_ms + missing - grow_left)
        if end_ms - start_ms < min_length:
            start_ms = max(0, end_ms - min_length)

    return CandidateWindow(
        start_ms=start_ms,
        end_ms=end_ms,
        transcript=window.transcript,
        reasons=_dedupe_reasons(window.reasons),
        anchor_kind=window.anchor_kind,
        anchor_ms=window.anchor_ms,
    )


def _max_window_length_ms(duration_ms: int) -> int:
    if duration_ms <= 0:
        return 0

    max_length = min(MAX_CLIP_MS, duration_ms)
    if duration_ms > WHOLE_SOURCE_MAX_MS:
        max_length = min(max_length, int(duration_ms * MAX_SOURCE_SPAN_RATIO))
    return max_length


def _allows_whole_source_candidate(duration_ms: int) -> bool:
    return 0 < duration_ms < WHOLE_SOURCE_MAX_MS


def _has_transcript(transcript: Transcript) -> bool:
    return bool(
        transcript.text.strip()
        or any(segment.text.strip() for segment in transcript.segments)
    )


def _segment_index_for_time(
    segments: list[TranscriptSegment],
    time_ms: int,
) -> int:
    if not segments:
        return 0

    for index, segment in enumerate(segments):
        if segment.start_ms <= time_ms < segment.end_ms:
            return index
        if time_ms < segment.start_ms:
            return index

    return len(segments) - 1


def _should_extend_backward_one_segment(
    anchor: CandidateAnchor,
    segments: list[TranscriptSegment],
    start_index: int,
    end_ms: int,
    duration_ms: int,
) -> bool:
    if start_index <= 0:
        return False

    previous = segments[start_index - 1]
    current = segments[start_index]
    if current.start_ms - previous.end_ms > MID_THOUGHT_GAP_MS:
        return False

    budget_ms = min(_max_window_length_ms(duration_ms), TARGET_MAX_CLIP_MS)
    if end_ms - previous.start_ms > budget_ms:
        return False

    current_tokens = TOKEN_RE.findall(_normalize_text(current.text))
    first_token = current_tokens[0] if current_tokens else ""
    if first_token in CONTINUATION_STARTERS:
        return True

    previous_text = previous.text.strip()
    if previous_text and not previous_text.endswith(TERMINAL_PUNCTUATION):
        return True

    return anchor.kind == "energy" and anchor.anchor_ms - current.start_ms > 2_000


def _anchor_strength_key(window: CandidateWindow) -> tuple[int, int, int, int]:
    return (
        _anchor_kind_priority(window.anchor_kind),
        window.anchor_ms,
        window.start_ms,
        window.end_ms,
    )


def _anchor_kind_priority(kind: str) -> int:
    if kind == "hook":
        return 0
    if kind == "energy":
        return 1
    return 2


def _window_iou(first: CandidateWindow, second: CandidateWindow) -> float:
    intersection = max(
        0,
        min(first.end_ms, second.end_ms) - max(first.start_ms, second.start_ms),
    )
    if intersection == 0:
        return 0.0

    union = (
        max(first.end_ms, second.end_ms)
        - min(first.start_ms, second.start_ms)
    )
    if union <= 0:
        return 0.0

    return intersection / union


def _overlaps(segment: TranscriptSegment, start_ms: int, end_ms: int) -> bool:
    return segment.end_ms > start_ms and segment.start_ms < end_ms


def _dedupe_reasons(reasons: list[str]) -> list[str]:
    deduped: list[str] = []
    for reason in reasons:
        if reason and reason not in deduped:
            deduped.append(reason)
    return deduped


def _normalize_text(text: str) -> str:
    return _squash_whitespace(text.lower())


def _squash_whitespace(text: str) -> str:
    return " ".join(text.split())

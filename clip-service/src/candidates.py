"""Candidate window extraction from transcript hooks and audio energy."""

from __future__ import annotations

import re
import statistics
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from .transcribe import Transcript, TranscriptSegment

MIN_CLIP_MS = 10_000
MAX_CLIP_MS = 90_000
HOOK_WINDOW_MS = 28_000
HOOK_PRE_ROLL_MS = 1_500
ENERGY_PRE_ROLL_MS = 5_000
ENERGY_POST_ROLL_MS = 18_000
MERGE_GAP_MS = 1_500

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

    def to_response(self) -> dict[str, object]:
        return {
            "start_ms": self.start_ms,
            "end_ms": self.end_ms,
            "transcript": self.transcript,
            "reasons": self.reasons,
        }


@dataclass(frozen=True)
class LoudnessSample:
    time_ms: int
    momentary_lufs: float


def build_candidates(
    video_path: Path,
    transcript: Transcript,
    duration_ms: int,
) -> list[CandidateWindow]:
    raw_windows: list[CandidateWindow] = []
    raw_windows.extend(transcript_hook_windows(transcript, duration_ms))
    raw_windows.extend(audio_energy_windows(video_path, duration_ms))

    merged = merge_overlapping_windows(raw_windows, duration_ms)
    for window in merged:
        window.transcript = transcript_for_window(transcript, window.start_ms, window.end_ms)

    candidates = [window for window in merged if window.transcript]
    if not candidates and transcript.segments:
        candidates = [_opening_transcript_candidate(transcript, duration_ms)]

    return candidates


def transcript_hook_windows(
    transcript: Transcript,
    duration_ms: int,
) -> list[CandidateWindow]:
    windows: list[CandidateWindow] = []

    for segment in transcript.segments:
        reasons = hook_reasons(segment.text)
        if not reasons:
            continue

        start_ms = segment.start_ms - HOOK_PRE_ROLL_MS
        end_ms = max(segment.end_ms, segment.start_ms + HOOK_WINDOW_MS)
        windows.append(
            _clamp_window(
                CandidateWindow(start_ms, end_ms, reasons=reasons),
                duration_ms,
            )
        )

    return windows


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


def audio_energy_windows(video_path: Path, duration_ms: int) -> list[CandidateWindow]:
    samples = loudness_samples(video_path)
    spikes = energy_spike_groups(samples)
    windows: list[CandidateWindow] = []

    for group in spikes:
        start_ms = group[0].time_ms - ENERGY_PRE_ROLL_MS
        end_ms = group[-1].time_ms + ENERGY_POST_ROLL_MS
        windows.append(
            _clamp_window(
                CandidateWindow(
                    start_ms=start_ms,
                    end_ms=end_ms,
                    reasons=["audio energy: spike above rolling baseline"],
                ),
                duration_ms,
            )
        )

    return windows


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


def merge_overlapping_windows(
    windows: list[CandidateWindow],
    duration_ms: int,
    gap_ms: int = MERGE_GAP_MS,
) -> list[CandidateWindow]:
    prepared = [
        _clamp_window(window, duration_ms)
        for window in windows
        if window.end_ms > window.start_ms
    ]
    prepared.sort(key=lambda window: (window.start_ms, window.end_ms))

    merged: list[CandidateWindow] = []
    for window in prepared:
        if not merged or window.start_ms > merged[-1].end_ms + gap_ms:
            merged.append(window)
            continue

        current = merged[-1]
        current.end_ms = max(current.end_ms, window.end_ms)
        current.reasons = _dedupe_reasons([*current.reasons, *window.reasons])
        merged[-1] = _clamp_window(current, duration_ms)

    return merged


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
    first = transcript.segments[0]
    window = _clamp_window(
        CandidateWindow(
            start_ms=first.start_ms,
            end_ms=max(first.end_ms, first.start_ms + HOOK_WINDOW_MS),
            reasons=["transcript hook: opening"],
        ),
        duration_ms,
    )
    window.transcript = transcript_for_window(transcript, window.start_ms, window.end_ms)
    return window


def _clamp_window(window: CandidateWindow, duration_ms: int) -> CandidateWindow:
    if duration_ms <= 0:
        return CandidateWindow(0, 0, transcript=window.transcript, reasons=window.reasons)

    start_ms = max(0, min(window.start_ms, duration_ms))
    end_ms = max(start_ms, min(window.end_ms, duration_ms))
    length_ms = end_ms - start_ms

    max_length = min(MAX_CLIP_MS, duration_ms)
    min_length = min(MIN_CLIP_MS, duration_ms)

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
    )


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

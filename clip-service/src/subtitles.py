"""ASS subtitle generation for caption presets."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .presets import CaptionPreset
from .transcribe import Transcript, TranscriptSegment, TranscriptWord

PLAY_RES_X = 1080
PLAY_RES_Y = 1920
MAX_LINES_PER_EVENT = 2
MIN_EVENT_MS = 350


@dataclass(frozen=True)
class AssEvent:
    start_ms: int
    end_ms: int
    text: str


def transcript_from_payload(payload: Any) -> Transcript:
    if isinstance(payload, str):
        text = _squash_whitespace(payload)
        return Transcript(text=text, segments=[], words=[])

    if not isinstance(payload, dict):
        raise TypeError("transcript must be an object or string.")

    text = _squash_whitespace(str(payload.get("text") or payload.get("transcript") or ""))
    segments_payload = payload.get("segments") or []
    words_payload = payload.get("words") or []

    if not isinstance(segments_payload, list):
        raise TypeError("transcript.segments must be a list.")
    if not isinstance(words_payload, list):
        raise TypeError("transcript.words must be a list.")

    segments = [_segment_from_payload(item) for item in segments_payload]
    words = [_word_from_payload(item) for item in words_payload]

    return Transcript(
        text=text,
        segments=[segment for segment in segments if segment is not None],
        words=[word for word in words if word is not None],
    )


def transcript_for_cut(
    transcript: Transcript,
    source_start_ms: int,
    source_end_ms: int,
) -> Transcript:
    duration_ms = max(0, source_end_ms - source_start_ms)
    if duration_ms <= 0:
        return Transcript(text="", segments=[], words=[])

    if _has_timed_overlap(transcript, source_start_ms, source_end_ms):
        base_start_ms = source_start_ms
        base_end_ms = source_end_ms
    else:
        base_start_ms = 0
        base_end_ms = duration_ms

    segments = [
        segment
        for segment in (
            _clip_segment(segment, base_start_ms, base_end_ms)
            for segment in transcript.segments
        )
        if segment is not None
    ]
    words = [
        word
        for word in (
            _clip_word(word, base_start_ms, base_end_ms)
            for word in transcript.words
        )
        if word is not None
    ]

    text = _squash_whitespace(" ".join(segment.text for segment in segments))
    if not text:
        text = transcript.text.strip()
    if text and not segments:
        segments = [TranscriptSegment(start_ms=0, end_ms=duration_ms, text=text)]

    return Transcript(text=text, segments=segments, words=words)


def generate_ass(
    transcript: Transcript,
    preset: CaptionPreset,
    duration_ms: int,
) -> str:
    if preset.highlight_style == "karaoke":
        events = _karaoke_events(transcript, preset, duration_ms)
    else:
        events = _static_events(transcript, preset, duration_ms)

    lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {PLAY_RES_X}",
        f"PlayResY: {PLAY_RES_Y}",
        "ScaledBorderAndShadow: yes",
        "WrapStyle: 2",
        "",
        "[V4+ Styles]",
        (
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
            "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
            "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
            "Alignment, MarginL, MarginR, MarginV, Encoding"
        ),
        (
            "Style: Default,"
            f"{preset.font},{preset.font_size},{preset.primary_color},"
            f"{preset.secondary_color},{preset.outline_color},{preset.back_color},"
            "1,0,0,0,100,100,0,0,1,"
            f"{preset.outline},{preset.shadow},{preset.alignment},"
            f"{preset.margin_l},{preset.margin_r},{preset.margin_v},1"
        ),
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]

    for event in events:
        lines.append(
            "Dialogue: 0,"
            f"{_ass_timestamp(event.start_ms)},{_ass_timestamp(event.end_ms)},"
            f"Default,,0,0,0,,{event.text}"
        )

    return "\n".join(lines) + "\n"


def _static_events(
    transcript: Transcript,
    preset: CaptionPreset,
    duration_ms: int,
) -> list[AssEvent]:
    if transcript.words:
        return _static_word_events(transcript.words, preset, duration_ms)

    segments = transcript.segments
    if not segments and transcript.text.strip():
        segments = [
            TranscriptSegment(
                start_ms=0,
                end_ms=duration_ms,
                text=transcript.text.strip(),
            )
        ]

    events: list[AssEvent] = []
    for segment in segments:
        words = _split_caption_words(segment.text)
        if not words:
            continue

        chunks = _chunks(words, preset.max_words_per_line * MAX_LINES_PER_EVENT)
        segment_duration_ms = max(0, segment.end_ms - segment.start_ms)
        for index, chunk in enumerate(chunks):
            start_ms = segment.start_ms + round(segment_duration_ms * index / len(chunks))
            end_ms = segment.start_ms + round(segment_duration_ms * (index + 1) / len(chunks))
            bounds = _event_bounds(start_ms, end_ms, duration_ms)
            if bounds is None:
                continue
            events.append(
                AssEvent(
                    start_ms=bounds[0],
                    end_ms=bounds[1],
                    text=_wrap_words(chunk, preset.max_words_per_line),
                )
            )

    return events


def _static_word_events(
    words: list[TranscriptWord],
    preset: CaptionPreset,
    duration_ms: int,
) -> list[AssEvent]:
    events: list[AssEvent] = []
    for group in _chunks(words, preset.max_words_per_line * MAX_LINES_PER_EVENT):
        bounds = _event_bounds(group[0].start_ms, group[-1].end_ms, duration_ms)
        if bounds is None:
            continue
        events.append(
            AssEvent(
                start_ms=bounds[0],
                end_ms=bounds[1],
                text=_wrap_words(
                    [word.word for word in group],
                    preset.max_words_per_line,
                ),
            )
        )
    return events


def _karaoke_events(
    transcript: Transcript,
    preset: CaptionPreset,
    duration_ms: int,
) -> list[AssEvent]:
    words = transcript.words
    if not words:
        segments = transcript.segments
        if not segments and transcript.text.strip():
            segments = [
                TranscriptSegment(
                    start_ms=0,
                    end_ms=duration_ms,
                    text=transcript.text.strip(),
                )
            ]
        words = _synthesize_words(segments)

    events: list[AssEvent] = []
    for group in _chunks(words, preset.max_words_per_line * MAX_LINES_PER_EVENT):
        text, end_ms = _karaoke_text(group, preset.max_words_per_line, duration_ms)
        bounds = _event_bounds(group[0].start_ms, end_ms, duration_ms)
        if bounds is None:
            continue
        events.append(AssEvent(start_ms=bounds[0], end_ms=bounds[1], text=text))
    return events


def _karaoke_text(
    words: list[TranscriptWord],
    max_words_per_line: int,
    duration_ms: int,
) -> tuple[str, int]:
    parts: list[str] = []
    elapsed_cs = 0

    for index, word in enumerate(words):
        if index and index % max_words_per_line == 0:
            parts.append(r"\N")
        elif index:
            parts.append(" ")

        next_start_ms = (
            words[index + 1].start_ms if index + 1 < len(words) else word.end_ms
        )
        word_end_ms = max(word.end_ms, next_start_ms)
        duration_cs = max(1, round((word_end_ms - word.start_ms) / 10))
        elapsed_cs += duration_cs
        parts.append(rf"{{\k{duration_cs}}}{_ass_text(word.word)}")

    end_ms = min(duration_ms, words[0].start_ms + elapsed_cs * 10)
    return "".join(parts), end_ms


def _synthesize_words(segments: list[TranscriptSegment]) -> list[TranscriptWord]:
    words: list[TranscriptWord] = []
    for segment in segments:
        pieces = _split_caption_words(segment.text)
        if not pieces:
            continue
        duration_ms = max(segment.end_ms - segment.start_ms, len(pieces) * 180)
        for index, word in enumerate(pieces):
            start_ms = segment.start_ms + round(duration_ms * index / len(pieces))
            end_ms = segment.start_ms + round(duration_ms * (index + 1) / len(pieces))
            words.append(TranscriptWord(start_ms=start_ms, end_ms=end_ms, word=word))
    return words


def _segment_from_payload(item: Any) -> TranscriptSegment | None:
    if not isinstance(item, dict):
        raise TypeError("Each transcript segment must be an object.")

    text = _squash_whitespace(str(item.get("text") or ""))
    if not text:
        return None

    start_ms = _timestamp_from_payload(item, "start_ms", "start")
    end_ms = _timestamp_from_payload(item, "end_ms", "end")
    if end_ms < start_ms:
        raise ValueError("transcript segment end_ms must be after start_ms.")
    return TranscriptSegment(start_ms=start_ms, end_ms=end_ms, text=text)


def _word_from_payload(item: Any) -> TranscriptWord | None:
    if not isinstance(item, dict):
        raise TypeError("Each transcript word must be an object.")

    word = _squash_whitespace(str(item.get("word") or item.get("text") or ""))
    if not word:
        return None

    start_ms = _timestamp_from_payload(item, "start_ms", "start")
    end_ms = _timestamp_from_payload(item, "end_ms", "end")
    if end_ms <= start_ms:
        end_ms = start_ms + 100
    return TranscriptWord(start_ms=start_ms, end_ms=end_ms, word=word)


def _timestamp_from_payload(item: dict[str, Any], ms_key: str, seconds_key: str) -> int:
    if ms_key in item:
        raw_value = item[ms_key]
        try:
            return max(0, int(raw_value))
        except (TypeError, ValueError) as exc:
            raise ValueError(f"transcript {ms_key} must be an integer.") from exc

    if seconds_key in item:
        raw_value = item[seconds_key]
        try:
            return max(0, round(float(raw_value) * 1000))
        except (TypeError, ValueError) as exc:
            raise ValueError(f"transcript {seconds_key} must be numeric seconds.") from exc

    return 0


def _clip_segment(
    segment: TranscriptSegment,
    start_ms: int,
    end_ms: int,
) -> TranscriptSegment | None:
    if segment.end_ms <= start_ms or segment.start_ms >= end_ms:
        return None
    clipped_start_ms = max(0, segment.start_ms - start_ms)
    clipped_end_ms = min(end_ms - start_ms, segment.end_ms - start_ms)
    if clipped_end_ms <= clipped_start_ms:
        return None
    return TranscriptSegment(
        start_ms=clipped_start_ms,
        end_ms=clipped_end_ms,
        text=segment.text,
    )


def _clip_word(
    word: TranscriptWord,
    start_ms: int,
    end_ms: int,
) -> TranscriptWord | None:
    if word.end_ms <= start_ms or word.start_ms >= end_ms:
        return None
    clipped_start_ms = max(0, word.start_ms - start_ms)
    clipped_end_ms = min(end_ms - start_ms, word.end_ms - start_ms)
    if clipped_end_ms <= clipped_start_ms:
        clipped_end_ms = clipped_start_ms + 100
    return TranscriptWord(
        start_ms=clipped_start_ms,
        end_ms=clipped_end_ms,
        word=word.word,
    )


def _has_timed_overlap(transcript: Transcript, start_ms: int, end_ms: int) -> bool:
    for segment in transcript.segments:
        if segment.end_ms > start_ms and segment.start_ms < end_ms:
            return True
    for word in transcript.words:
        if word.end_ms > start_ms and word.start_ms < end_ms:
            return True
    return False


def _event_bounds(start_ms: int, end_ms: int, duration_ms: int) -> tuple[int, int] | None:
    if duration_ms <= 0:
        return None

    start_ms = max(0, min(start_ms, duration_ms - 1))
    end_ms = max(start_ms + 1, min(end_ms, duration_ms))
    minimum_ms = min(MIN_EVENT_MS, duration_ms)

    if end_ms - start_ms < minimum_ms:
        end_ms = min(duration_ms, start_ms + minimum_ms)
        start_ms = max(0, end_ms - minimum_ms)

    if end_ms <= start_ms:
        return None
    return start_ms, end_ms


def _chunks[T](items: list[T], size: int) -> list[list[T]]:
    size = max(1, size)
    return [items[index : index + size] for index in range(0, len(items), size)]


def _wrap_words(words: list[str], max_words_per_line: int) -> str:
    cleaned = [_ass_text(word) for word in words if _ass_text(word)]
    lines = [
        " ".join(cleaned[index : index + max_words_per_line])
        for index in range(0, len(cleaned), max_words_per_line)
    ]
    return r"\N".join(line for line in lines if line)


def _split_caption_words(text: str) -> list[str]:
    return [word for word in _squash_whitespace(text).split(" ") if word]


def _ass_text(value: str) -> str:
    text = _squash_whitespace(value)
    return text.replace("\\", "/").replace("{", "(").replace("}", ")")


def _ass_timestamp(ms: int) -> str:
    total_cs = max(0, round(ms / 10))
    hours = total_cs // 360_000
    remainder = total_cs % 360_000
    minutes = remainder // 6_000
    remainder %= 6_000
    seconds = remainder // 100
    centiseconds = remainder % 100
    return f"{hours}:{minutes:02d}:{seconds:02d}.{centiseconds:02d}"


def _squash_whitespace(text: str) -> str:
    return " ".join(text.split())

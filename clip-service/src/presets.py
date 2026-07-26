"""Curated caption-style presets for burned-in subtitles."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

HighlightStyle = Literal["static", "karaoke"]


@dataclass(frozen=True)
class CaptionPreset:
    preset_id: str
    font: str
    font_size: int
    primary_color: str
    secondary_color: str
    outline_color: str
    back_color: str
    outline: int
    shadow: int
    alignment: int
    margin_l: int
    margin_r: int
    margin_v: int
    max_words_per_line: int
    highlight_style: HighlightStyle


# Clean bold: white lower-third captions for readable gameplay overlays.
CLEAN_BOLD = CaptionPreset(
    preset_id="clean-bold",
    font="Arial",
    font_size=82,
    primary_color="&H00FFFFFF",
    secondary_color="&H00FFFFFF",
    outline_color="&H00000000",
    back_color="&H80000000",
    outline=3,
    shadow=0,
    alignment=2,
    margin_l=96,
    margin_r=96,
    margin_v=300,
    max_words_per_line=4,
    highlight_style="static",
)

# Outline pop: larger amber captions with a thicker outline for noisy footage.
OUTLINE_POP = CaptionPreset(
    preset_id="outline-pop",
    font="Arial",
    font_size=92,
    primary_color="&H006DE6FF",
    secondary_color="&H006DE6FF",
    outline_color="&H00000000",
    back_color="&H80000000",
    outline=5,
    shadow=3,
    alignment=2,
    margin_l=90,
    margin_r=90,
    margin_v=380,
    max_words_per_line=3,
    highlight_style="static",
)

# Karaoke: word-timed yellow highlight, kept as the only karaoke preset.
KARAOKE = CaptionPreset(
    preset_id="karaoke",
    font="Arial",
    font_size=84,
    primary_color="&H0000D7FF",
    secondary_color="&H00FFFFFF",
    outline_color="&H00000000",
    back_color="&H80000000",
    outline=4,
    shadow=2,
    alignment=2,
    margin_l=96,
    margin_r=96,
    margin_v=280,
    max_words_per_line=4,
    highlight_style="karaoke",
)


CAPTION_PRESETS: dict[str, CaptionPreset] = {
    preset.preset_id: preset
    for preset in (
        CLEAN_BOLD,
        OUTLINE_POP,
        KARAOKE,
    )
}


def get_caption_preset(preset_id: str) -> CaptionPreset | None:
    return CAPTION_PRESETS.get(preset_id)


def validate_caption_presets() -> None:
    if len(CAPTION_PRESETS) != 3:
        raise ValueError("Exactly 3 caption presets must be registered.")

    karaoke_count = sum(
        1 for preset in CAPTION_PRESETS.values() if preset.highlight_style == "karaoke"
    )
    if karaoke_count != 1:
        raise ValueError("Exactly one caption preset may use karaoke highlighting.")

    for preset in CAPTION_PRESETS.values():
        if preset.max_words_per_line < 1:
            raise ValueError(f"{preset.preset_id} must allow at least one word per line.")
        if preset.alignment not in {2, 8}:
            raise ValueError(f"{preset.preset_id} must use a safe centered alignment.")
        if min(preset.margin_l, preset.margin_r, preset.margin_v) < 0:
            raise ValueError(f"{preset.preset_id} margins must be non-negative.")

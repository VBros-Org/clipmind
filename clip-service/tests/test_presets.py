from __future__ import annotations

from src.presets import CAPTION_PRESETS, validate_caption_presets


def test_caption_preset_registry_is_valid() -> None:
    validate_caption_presets()

    assert set(CAPTION_PRESETS) == {"clean-bold", "outline-pop", "karaoke"}
    assert {preset.font for preset in CAPTION_PRESETS.values()} == {
        "DejaVu Sans",
        "DejaVu Sans Condensed",
        "DejaVu Serif",
    }
    assert (
        sum(
            1
            for preset in CAPTION_PRESETS.values()
            if preset.highlight_style == "karaoke"
        )
        == 1
    )

    for preset in CAPTION_PRESETS.values():
        assert preset.font
        assert preset.font_size > 0
        assert preset.max_words_per_line > 0

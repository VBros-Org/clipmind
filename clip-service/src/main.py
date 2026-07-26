"""ClipMind clip service (stateless).

Speech-first clipping: transcribe (Whisper), surface candidate windows from
speech plus cheap audio spikes (loudness / shout / laughter), cut to 9:16, and
burn in subtitles from the transcript using the creator's caption-style preset.
No GPU, no vision, no face tracking. See docs/build-plan.md sections 6 and 9.

Endpoints beyond /health land as they are built, one bounded ticket at a time.
"""
from fastapi import FastAPI

app = FastAPI(title="ClipMind Clip Service")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}

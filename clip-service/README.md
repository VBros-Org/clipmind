# ClipMind clip service

Python 3.12, FastAPI. Stateless. No database.

Speech-first: transcribe (Whisper), surface candidate windows from speech plus cheap audio spikes (loudness, shout, laughter), cut to 9:16, burn in subtitles from the transcript using the creator's caption-style preset. No GPU, no vision, no face tracking. That stack stays on George's tower. See [`../docs/build-plan.md`](../docs/build-plan.md) sections 6 and 9.

## System dependency
`ffmpeg` must be installed on the host.

## Setup
1. `cp .env.example .env` and fill it in.
2. `python -m venv .venv && source .venv/bin/activate`
3. `pip install -r requirements.txt`
4. `uvicorn src.main:app --reload --port 8000`
5. `GET /health` returns `{"status":"ok"}`

## Auth
Token-gated. The backend and the Minds agent (via `HTTP_Execute`) call this service with `CLIP_SERVICE_TOKEN`. Never expose it unauthenticated.

## Candidates
`POST /candidates` requires `Authorization: Bearer <CLIP_SERVICE_TOKEN>`.

Send either:
- multipart form data with a `file` field containing the video
- JSON with `source_url` set to an `http` or `https` video URL

The response contains `duration_ms` and `candidates`. Each candidate has `start_ms`, `end_ms`, `transcript`, and `reasons`.

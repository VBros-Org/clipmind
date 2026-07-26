"""Environment loading and validation for the clip service."""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = SERVICE_ROOT / ".env"
REQUIRED_ENV = ("OPENAI_API_KEY", "CLIP_SERVICE_TOKEN")


@dataclass(frozen=True)
class Settings:
    openai_api_key: str
    clip_service_token: str
    port: int


def _clean_env_value(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def load_env_file(path: Path = ENV_FILE) -> None:
    """Load a local .env file without printing secret values."""
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        if key.startswith("export "):
            key = key.removeprefix("export ").strip()
        if not key:
            continue

        os.environ.setdefault(key, _clean_env_value(value))


def _required_value(key: str) -> str:
    value = os.getenv(key)
    return value.strip() if value else ""


def load_settings() -> Settings:
    load_env_file()

    missing = [key for key in REQUIRED_ENV if not _required_value(key)]
    if missing:
        missing_list = ", ".join(missing)
        raise RuntimeError(
            "Missing required environment variables for clip service: "
            f"{missing_list}"
        )

    raw_port = os.getenv("PORT", "8000").strip()
    try:
        port = int(raw_port)
    except ValueError as exc:
        raise RuntimeError("PORT must be an integer.") from exc

    return Settings(
        openai_api_key=_required_value("OPENAI_API_KEY"),
        clip_service_token=_required_value("CLIP_SERVICE_TOKEN"),
        port=port,
    )


@lru_cache
def get_settings() -> Settings:
    return load_settings()


def reset_settings_cache() -> None:
    get_settings.cache_clear()

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# DejaVu is open-source and ships in Debian's fonts-dejavu-core package.
# Installing it explicitly keeps ASS subtitle presets stable on Railway Linux.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        ffmpeg \
        fontconfig \
        fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src ./src

CMD ["sh", "-c", "uvicorn src.main:app --host :: --port ${PORT:-8000}"]

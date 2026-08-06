FROM python:3.11-slim

# Agent SDK spawns the `claude` CLI as a subprocess, so Node + the CLI package
# must be present in the image (not just the Python SDK).
# `fonts-nanum` is for the note PDF (backend/notepdf.py). reportlab embeds the TTF, and
# without a Korean face the whole document renders as blank boxes *without raising* —
# so the PDF route refuses to run when this package is missing.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg fonts-nanum \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g @anthropic-ai/claude-code \
    && apt-get purge -y curl gnupg && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /repo
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]

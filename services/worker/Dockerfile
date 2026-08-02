FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
COPY services/worker/pyproject.toml /tmp/worker/pyproject.toml
COPY services/worker/src/aula_clara_worker/__init__.py /tmp/worker/src/aula_clara_worker/__init__.py
RUN pip install --no-cache-dir /tmp/worker && playwright install --with-deps chromium
COPY services/worker /app/services/worker
RUN pip install --no-cache-dir --no-deps --force-reinstall /app/services/worker
WORKDIR /app/services/worker
CMD ["aula-clara-worker"]

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
COPY services/worker /app/services/worker
RUN pip install --no-cache-dir /app/services/worker && playwright install --with-deps chromium
WORKDIR /app/services/worker
CMD ["aula-clara-worker"]

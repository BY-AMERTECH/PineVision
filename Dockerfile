FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PINEVISION_DATA_DIR=/mnt/pinevision \
    PINEVISION_MODEL_PATH=/mnt/pinevision/best.pt \
    MEDIAMTX_PATH=/usr/local/bin/mediamtx

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl ffmpeg libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# MediaMTX is a standalone Linux binary managed as a child process by Flask.
ARG MEDIAMTX_VERSION=1.21.3
RUN curl -fsSL "https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/mediamtx_v${MEDIAMTX_VERSION}_linux_amd64.tar.gz" \
      -o /tmp/mediamtx.tar.gz \
    && tar -xzf /tmp/mediamtx.tar.gz -C /usr/local/bin mediamtx \
    && chmod +x /usr/local/bin/mediamtx \
    && rm /tmp/mediamtx.tar.gz

WORKDIR /app
COPY backend/requirements.txt /app/backend/requirements.txt
RUN python -m pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu \
      --extra-index-url https://pypi.org/simple torch torchvision \
    && python -m pip install --no-cache-dir -r /app/backend/requirements.txt gunicorn

COPY backend/ /app/backend/
COPY frontend/ /app/frontend/
COPY mediamtx/mediamtx.yml /app/mediamtx/mediamtx.yml
WORKDIR /app/backend

EXPOSE 5000 1935
CMD ["sh", "-c", "exec gunicorn --worker-class gthread --workers 1 --threads 100 --bind 0.0.0.0:${PORT:-5000} app:app"]

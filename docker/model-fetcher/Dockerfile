# syntax=docker/dockerfile:1
# Eris model-fetcher — downloads GGUF models from Hugging Face Hub.

FROM python:3.12-slim@sha256:57cd7c3a7a273101a6485ba99423ee568157882804b1124b4dd04266317710de

WORKDIR /app

# Install deps first for layer caching
COPY requirements.txt ./
RUN pip install --no-cache-dir --require-hashes -r requirements.txt

COPY main.py ./
COPY --chmod=0555 model-volume-init.sh /usr/local/bin/interloom-model-volume-init

RUN groupadd --gid 10001 interloom \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin interloom \
    && mkdir -p /models /app \
    && chown -R 10001:10001 /models /app

ENV MODELS_DIR=/models \
    PORT=7423

VOLUME /models

EXPOSE 7423

USER 10001:10001

CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7423"]

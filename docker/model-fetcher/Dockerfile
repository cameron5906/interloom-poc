# syntax=docker/dockerfile:1
# Interloom model-fetcher — downloads GGUF models from Hugging Face Hub.

FROM python:3.12-slim

WORKDIR /app

# Install deps first for layer caching
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py ./

ENV MODELS_DIR=/models \
    PORT=7423

VOLUME /models

EXPOSE 7423

CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7423"]

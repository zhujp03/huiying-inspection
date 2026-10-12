# OCR sidecar

This directory hosts the private PaddleOCR sidecar. It receives image bytes only; it must never receive database, COS, SMS, or business credentials.

`POST /v1/ocr` accepts JPEG/PNG bytes up to 10 MiB and returns ordered `{ text, confidence, boundingBox }` lines. The process uses the pinned `PaddleOCR 3.7.0` / `PaddleX 3.7.2` runtime to load `PP-OCRv6_small_det` and `PP-OCRv6_small_rec` at startup; set `OCR_DEVICE`, `OCR_DETECTION_MODEL`, or `OCR_RECOGNITION_MODEL` only when deploying an intentionally different local model.

Deploy this CPU sidecar on Linux x86-64. Build it with `docker build --platform linux/amd64 -f ops/docker/Dockerfile.ocr -t junde-ocr:amd64-verify .` (tag must match the `image:` in `ops/docker/docker-compose.production.yml`), then set the Worker `OCR_SERVICE_URL` to its private network URL. It has no public route and no cloud-OCR fallback. The local arm64 image must not be used: its first native inference call segfaulted during verification.

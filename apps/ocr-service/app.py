import os
from contextlib import asynccontextmanager

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, Request
from paddleocr import PaddleOCR

MAX_IMAGE_BYTES = 10 * 1024 * 1024
MODEL_DET = os.getenv("OCR_DETECTION_MODEL", "PP-OCRv6_small_det")
MODEL_REC = os.getenv("OCR_RECOGNITION_MODEL", "PP-OCRv6_small_rec")
DEVICE = os.getenv("OCR_DEVICE", "cpu")


def as_json(value):
    return value.tolist() if hasattr(value, "tolist") else value


def result_payload(result):
    raw = getattr(result, "json", result)
    raw = raw() if callable(raw) else raw
    if not isinstance(raw, dict):
        raise ValueError("unsupported PaddleOCR result")
    return raw.get("res", raw)


def lines_from_result(result):
    payload = result_payload(result)
    texts = payload.get("rec_texts", [])
    scores = payload.get("rec_scores", [])
    boxes = payload.get("rec_polys", payload.get("dt_polys", []))
    if not (len(texts) == len(scores) == len(boxes)):
        raise ValueError("inconsistent PaddleOCR result")
    return [{"text": str(text), "confidence": float(score), "boundingBox": as_json(box)} for text, score, box in zip(texts, scores, boxes) if str(text).strip()]


@asynccontextmanager
async def lifespan(app):
    app.state.ocr = PaddleOCR(
        text_detection_model_name=MODEL_DET,
        text_recognition_model_name=MODEL_REC,
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        device=DEVICE,
    )
    yield


app = FastAPI(title="Junde private PaddleOCR", lifespan=lifespan)


@app.get("/live")
async def live():
    return {"status": "ok"}


@app.get("/ready")
async def ready(request: Request):
    return {"status": "ready", "detectionModel": MODEL_DET, "recognitionModel": MODEL_REC}


@app.post("/v1/ocr")
async def recognize(request: Request):
    content_type = request.headers.get("content-type", "").split(";", 1)[0].lower()
    if content_type not in {"image/jpeg", "image/png", "application/octet-stream"}:
        raise HTTPException(415, "only JPEG and PNG images are accepted")
    body = await request.body()
    if not body or len(body) > MAX_IMAGE_BYTES:
        raise HTTPException(413, "image must be between 1 byte and 10 MiB")
    encoded = np.frombuffer(body, dtype=np.uint8)
    image = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(422, "invalid image content")
    try:
        output = list(request.app.state.ocr.predict(image))
        return {"lines": [line for result in output for line in lines_from_result(result)]}
    except ValueError as error:
        raise HTTPException(502, "invalid OCR result") from error
    except Exception as error:
        raise HTTPException(503, "OCR inference unavailable") from error

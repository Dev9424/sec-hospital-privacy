# SUPMS Anonymization ML Pipeline

Standalone FastAPI service for X-ray anonymization.

Pipeline:
X-ray -> metadata scrub -> OCR -> PHI classification -> FracAtlas YOLO protection -> redaction -> anonymized JPEG.

Important: if PHI overlaps a protected fracture box, the system does NOT clip the mask across the fracture. It marks the case `manual_review_required`. This avoids sacrificing privacy or silently modifying clinically relevant pixels.

Install:
`python -m venv .venv`
Windows: `.venv\Scripts\activate`
`pip install -r requirements.txt`
Install the Tesseract executable separately and put it on PATH.

Run:
`uvicorn app.main:app --host 127.0.0.1 --port 8010`

The FracAtlas annotations are read-only. The original dataset is never modified.

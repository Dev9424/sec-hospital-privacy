from pathlib import Path

PROJECT_ROOT = Path(r"D:\mtech project ref")

TESSERACT_PATH = PROJECT_ROOT / "tesseract.exe"
TESSDATA_PATH = PROJECT_ROOT / "tessdata"

FRACATLAS_ROOT = PROJECT_ROOT / "FracAtlas"
FRACTURED_IMAGES = FRACATLAS_ROOT / "images" / "Fractured"
NON_FRACTURED_IMAGES = FRACATLAS_ROOT / "images" / "Non_fractured"
YOLO_DIR = FRACATLAS_ROOT / "Annotations" / "YOLO"

OUTPUT_DIR = PROJECT_ROOT / "anonymized_output"

# OCR Configuration
OCR_MIN_CONFIDENCE = 30

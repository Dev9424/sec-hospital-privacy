import cv2, pytesseract, os
from pytesseract import Output
from .models import Box, OCRRegion

# Configure Tesseract explicitly
TESSERACT_CMD = r"D:\sec hospital\mtech project ref\tesseract.exe"
TESSDATA_DIR = r"D:\sec hospital\mtech project ref\tessdata"

if not os.path.exists(TESSERACT_CMD):
    raise FileNotFoundError(f"Tesseract executable not found at {TESSERACT_CMD}")

os.environ["TESSDATA_PREFIX"] = TESSDATA_DIR
pytesseract.pytesseract.tesseract_cmd = TESSERACT_CMD
tess_config = '--oem 3 --psm 11'

def detect_text(image_bgr, min_confidence=35):
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    scale = 2.0 if max(gray.shape) < 3000 else 1.5
    proc = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    proc = cv2.normalize(proc, None, 0, 255, cv2.NORM_MINMAX)
    d = pytesseract.image_to_data(proc, config=tess_config, output_type=Output.DICT)
    out = []
    for i, t in enumerate(d["text"]):
        t = (t or "").strip()
        try:
            c = float(d["conf"][i])
        except:
            c = -1
        if not t or c < min_confidence:
            continue
        x = round(d["left"][i] / scale)
        y = round(d["top"][i] / scale)
        w = round(d["width"][i] / scale)
        h = round(d["height"][i] / scale)
        if w > 0 and h > 0:
            ln = int(d["line_num"][i])
            bn = int(d["block_num"][i])
            out.append(OCRRegion(Box(x, y, x + w, y + h), t, c / 100, ln, bn))
    return out

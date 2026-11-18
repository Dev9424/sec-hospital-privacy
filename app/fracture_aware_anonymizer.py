import re
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np
import pytesseract
from pytesseract import Output

from .phi_classifier import classify

@dataclass
class Box:
    x1: int
    y1: int
    x2: int
    y2: int

    def intersects(self, other: "Box") -> bool:
        return not (
            self.x2 <= other.x1 or other.x2 <= self.x1 or
            self.y2 <= other.y1 or other.y2 <= self.y1
        )

# Legacy patterns kept for reference — actual classification now uses phi_classifier.classify()
DATE_PATTERN = re.compile(r"\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b")
PATIENT_ID_PATTERN = re.compile(r"\b(?:PT|MRN|ID)[-#]?\d{3,8}\b", re.IGNORECASE)

PHI_KEYWORDS = ["dob", "scan date", "patient"]

# REVIEW must NEVER be silently cleared as SAFE.
# Returns: "PHI" | "REVIEW" | "SAFE" | "EMPTY"
def classify_line(line_text: str, avg_confidence: float = 0.75) -> str:
    label, _score = classify(line_text, avg_confidence)
    return label  # "PHI", "REVIEW", "SAFE", or "EMPTY"

def line_is_phi(line_text: str) -> bool:
    """Kept for backward-compat; prefer classify_line()."""
    return classify_line(line_text) == "PHI"

def yolo_to_box(xc: float, yc: float, w: float, h: float, img_w: int, img_h: int) -> Box:
    x1 = max(0, round((xc - w / 2) * img_w))
    y1 = max(0, round((yc - h / 2) * img_h))
    x2 = min(img_w, round((xc + w / 2) * img_w))
    y2 = min(img_h, round((yc + h / 2) * img_h))
    return Box(x1, y1, x2, y2)

def load_yolo_boxes(fracture_boxes_yolo: Optional[List[Tuple[float, float, float, float]]], img_w: int, img_h: int) -> List[Box]:
    boxes = []
    for xc, yc, w, h in (fracture_boxes_yolo or []):
        if not all(0.0 <= v <= 1.0 for v in (xc, yc, w, h)):
            continue
        box = yolo_to_box(xc, yc, w, h, img_w, img_h)
        if (box.x2 - box.x1) > 0 and (box.y2 - box.y1) > 0:
            boxes.append(box)
    return boxes

def read_yolo_annotation_file(path: str) -> List[Tuple[float, float, float, float]]:
    boxes = []
    p = Path(path)
    if not p.is_file():
        return boxes
    for line in p.read_text(errors="ignore").splitlines():
        parts = line.split()
        if len(parts) != 5:
            continue
        try:
            _cls, xc, yc, w, h = parts
            boxes.append((float(xc), float(yc), float(w), float(h)))
        except ValueError:
            continue
    return boxes

def _pixelate_region(image: np.ndarray, box: Box, block_size: int = 8) -> None:
    x1, y1, x2, y2 = box.x1, box.y1, box.x2, box.y2
    if x2 <= x1 or y2 <= y1:
        return
    region = image[y1:y2, x1:x2]
    h, w = region.shape[:2]
    if h == 0 or w == 0:
        return
    small_w = max(1, w // block_size)
    small_h = max(1, h // block_size)
    small = cv2.resize(region, (small_w, small_h), interpolation=cv2.INTER_LINEAR)
    pixelated = cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST)
    image[y1:y2, x1:x2] = pixelated

def anonymize_xray(
    image: np.ndarray,
    fracture_boxes_yolo: Optional[List[Tuple[float, float, float, float]]] = None,
    min_confidence: int = 35,
    upscale_factor: float = 2.0,
) -> Tuple[np.ndarray, Dict]:
    original = image.copy()
    orig_h, orig_w = original.shape[:2]

    gray = cv2.cvtColor(original, cv2.COLOR_BGR2GRAY)
    upscaled = cv2.resize(gray, None, fx=upscale_factor, fy=upscale_factor, interpolation=cv2.INTER_CUBIC)
    normalized = cv2.normalize(upscaled, None, 0, 255, cv2.NORM_MINMAX)

    data = pytesseract.image_to_data(normalized, config="--oem 3 --psm 11", output_type=Output.DICT)

    n = len(data["text"])
    line_key_to_indices: Dict[Tuple[int, int, int], List[int]] = {}
    for i in range(n):
        word = data["text"][i].strip()
        try:
            conf = float(data["conf"][i])
        except (ValueError, TypeError):
            conf = -1.0
        if not word or conf < min_confidence:
            continue
        key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
        line_key_to_indices.setdefault(key, []).append(i)

    fracture_boxes = load_yolo_boxes(fracture_boxes_yolo, orig_w, orig_h)

    log: Dict = {
        "ocr_words_detected": 0,
        "phi_lines_detected": 0,
        "review_lines_detected": 0,
        "redacted_solid": 0,
        "redacted_pixelated": 0,
        "fracture_boxes": len(fracture_boxes),
        "lines": [],
        "review_lines": [],
    }

    output = original.copy()

    for idxs in line_key_to_indices.values():
        log["ocr_words_detected"] += len(idxs)
        line_text = " ".join(data["text"][i] for i in idxs)

        # Compute average word confidence for this line
        confs = [float(data["conf"][i]) for i in idxs if str(data["conf"][i]).lstrip("-").isdigit()]
        avg_conf = (sum(confs) / len(confs) / 100.0) if confs else 0.75

        classification = classify_line(line_text, avg_confidence=avg_conf)

        if classification in ("SAFE", "EMPTY"):
            log["lines"].append({"text": line_text, "phi": False, "action": "kept"})
            continue

        # Compute bounding box (shared for PHI and REVIEW)
        xs1 = [data["left"][i] for i in idxs]
        ys1 = [data["top"][i] for i in idxs]
        xs2 = [data["left"][i] + data["width"][i] for i in idxs]
        ys2 = [data["top"][i] + data["height"][i] for i in idxs]
        upscaled_box = Box(min(xs1), min(ys1), max(xs2), max(ys2))

        orig_box = Box(
            x1=max(0, round(upscaled_box.x1 / upscale_factor)),
            y1=max(0, round(upscaled_box.y1 / upscale_factor)),
            x2=min(orig_w, round(upscaled_box.x2 / upscale_factor)),
            y2=min(orig_h, round(upscaled_box.y2 / upscale_factor)),
        )
        pad = 4  # 4-pixel expansion on all sides (matches standalone anonymize_xray.py and paper §3.2)
        orig_box = Box(
            max(0, orig_box.x1 - pad), max(0, orig_box.y1 - pad),
            min(orig_w, orig_box.x2 + pad), min(orig_h, orig_box.y2 + pad),
        )

        overlaps_fracture = any(orig_box.intersects(fb) for fb in fracture_boxes)

        if classification == "REVIEW":
            # REVIEW: conservatively pixelate; surface to caller — NEVER silently pass as SAFE.
            _pixelate_region(output, orig_box, block_size=8)
            log["review_lines_detected"] += 1
            log["redacted_pixelated"]    += 1
            action = "REVIEW_pixelated"
            log["review_lines"].append({
                "text": line_text, "phi": True, "action": action,
                "box": [orig_box.x1, orig_box.y1, orig_box.x2, orig_box.y2],
                "overlaps_fracture": overlaps_fracture,
            })
            log["lines"].append({
                "text": line_text, "phi": True, "action": action,
                "box": [orig_box.x1, orig_box.y1, orig_box.x2, orig_box.y2],
            })
            continue

        # PHI
        log["phi_lines_detected"] += 1

        if overlaps_fracture:
            _pixelate_region(output, orig_box, block_size=8)
            log["redacted_pixelated"] += 1
            action = "pixelated"
        else:
            cv2.rectangle(output, (orig_box.x1, orig_box.y1), (orig_box.x2, orig_box.y2), (0, 0, 0), thickness=-1)
            log["redacted_solid"] += 1
            action = "redacted (solid)"

        log["lines"].append({
            "text": line_text, "phi": True, "action": action,
            "box": [orig_box.x1, orig_box.y1, orig_box.x2, orig_box.y2],
        })

    return output, log

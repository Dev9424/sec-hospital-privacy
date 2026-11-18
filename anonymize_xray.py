"""
anonymize_xray.py
-------------------
Real, working demonstration: OCR-based PHI detection and redaction on an
X-ray image with burned-in patient text, using pytesseract (Tesseract OCR).

Minimal research refactor (Phase 1):
  - PHI_KEYWORDS expanded to include 'scan' and 'date' so SCAN DATE lines
    are detected (previously missed).
  - anonymize() now returns List[Tuple[str, bool, List[int]]] where the
    third element is [x, y, w, h] of the merged line bounding box in the
    ORIGINAL image coordinate space. This enables pixel-level IoU evaluation
    against ground_truth.csv. Callers that only read the first two elements
    are unaffected.

NO algorithm changes were made to the detection or redaction logic.
"""

import re
import cv2
import pytesseract
from pytesseract import Output

PHI_PATTERNS = [
    re.compile(r"\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b"),           # dates
    re.compile(r"\b(?:PT|MRN|ID)[-#]?\d{3,8}\b", re.IGNORECASE), # patient IDs
]
PHI_KEYWORDS = ["patient", "id", "dob", "name", "scan", "date"]


def is_phi_word(word: str) -> bool:
    lowered = word.lower().strip(":")
    if any(p.search(word) for p in PHI_PATTERNS):
        return True
    if lowered in PHI_KEYWORDS:
        return True
    return False


def anonymize(input_path: str, output_path: str):
    image = cv2.imread(input_path)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    # OCR with bounding boxes for every detected word
    data = pytesseract.image_to_data(gray, output_type=Output.DICT)

    log = []
    n = len(data["text"])
    i = 0
    while i < n:
        word = data["text"][i].strip()
        if word:
            # Merge this word with the next ones on the same line to catch
            # multi-word PHI values like patient names, and to decide
            # redaction based on nearby PHI keywords (e.g. "PATIENT:" line).
            line_num = data["line_num"][i]
            block_num = data["block_num"][i]
            line_words_idx = [
                j for j in range(n)
                if data["line_num"][j] == line_num and data["block_num"][j] == block_num
                and data["text"][j].strip()
            ]
            line_text = " ".join(data["text"][j] for j in line_words_idx)
            line_is_phi = any(is_phi_word(w) for w in line_text.split()) or \
                          any(k in line_text.lower() for k in PHI_KEYWORDS)

            if line_is_phi:
                # Compute the merged bounding box for the whole line
                xs = [data["left"][j] for j in line_words_idx if data["text"][j].strip()]
                ys = [data["top"][j]  for j in line_words_idx if data["text"][j].strip()]
                ws = [data["width"][j]  for j in line_words_idx if data["text"][j].strip()]
                hs = [data["height"][j] for j in line_words_idx if data["text"][j].strip()]
                if xs:
                    line_x = min(xs)
                    line_y = min(ys)
                    line_w = max(x2 + w2 for x2, w2 in zip(xs, ws)) - line_x
                    line_h = max(y2 + h2 for y2, h2 in zip(ys, hs)) - line_y
                    line_bbox = [line_x, line_y, line_w, line_h]
                else:
                    line_bbox = []

                for j in line_words_idx:
                    if data["text"][j].strip():
                        x, y, w, h = (data["left"][j], data["top"][j],
                                      data["width"][j], data["height"][j])
                        cv2.rectangle(image, (x - 4, y - 4), (x + w + 4, y + h + 4),
                                      (0, 0, 0), thickness=-1)
                # Return (text, is_phi, bbox_xywh) — bbox is the merged line box
                log.append((line_text, True, line_bbox))
                # skip the rest of this line since we've handled it
                i = max(line_words_idx) + 1
                continue
            else:
                # Non-PHI word: bbox covers just this word
                word_bbox = [data["left"][i], data["top"][i],
                             data["width"][i], data["height"][i]]
                log.append((word, False, word_bbox))
        i += 1

    cv2.imwrite(output_path, image)
    return log


if __name__ == "__main__":
    log = anonymize("xray_with_phi.jpg", "xray_redacted.jpg")
    print("=" * 60)
    print("OCR DETECTION LOG:")
    seen = set()
    for entry in log:
        text, phi = entry[0], entry[1]
        bbox = entry[2] if len(entry) > 2 else []
        if text in seen:
            continue
        seen.add(text)
        marker = "REDACTED" if phi else "kept    "
        bbox_str = f"  bbox={bbox}" if bbox and phi else ""
        print(f"  [{marker}] {text}{bbox_str}")
    print("=" * 60)
    print("Saved: xray_redacted.jpg")

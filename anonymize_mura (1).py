"""
MURA X-ray Anonymization Pipeline
Objective 1 (image branch): De-identify musculoskeletal X-ray images from the
MURA dataset before they are used downstream.

MURA images have NO DICOM headers (Stanford already stripped them), so
anonymization here targets two things instead:

  1. FILENAME / PATH DE-IDENTIFICATION
     MURA paths look like:
       MURA-v1.1/train/XR_SHOULDER/patient00011/study1_positive/image1.png
     The "patientXXXXX" folder name IS the identifier. We replace it with a
     salted SHA-256 hash so the same patient maps consistently to the same
     anonymous ID, but the ID cannot be reversed to recover the original.

  2. BURNED-IN MARKER REDACTION
     Radiographs often have laterality markers ('L' / 'R'), stray text, or
     hospital/technologist stamps physically exposed onto the film corners.
     We detect high-contrast text-like blobs in the image border region and
     redact (blur + black box) them, since this is pixel data, not metadata,
     and DICOM-header scrubbing alone would miss it.

Usage:
    python anonymize_mura.py --input <MURA_root> --output <anon_root> --limit 200
"""

import argparse
import hashlib
import os
import shutil
import time
from pathlib import Path

import cv2
import numpy as np
import pytesseract

SALT = "mtech-project-2026-salt"  # fixed salt -> reproducible anon IDs across runs
BODY_PARTS = ["XR_SHOULDER", "XR_HUMERUS", "XR_FINGER", "XR_ELBOW",
              "XR_FOREARM", "XR_HAND", "XR_WRIST"]


def anon_patient_id(patient_folder: str) -> str:
    """patient00011 -> ANON-<12 hex chars>, deterministic via salted hash."""
    h = hashlib.sha256((SALT + patient_folder).encode()).hexdigest()[:12]
    return f"ANON-{h}"


def redact_burned_in_text(img: np.ndarray) -> np.ndarray:
    """
    Detect and redact likely burned-in markers/text anywhere in a radiograph
    using two complementary passes:

      Pass A - Tesseract OCR (image_to_data): catches actual alphanumeric
                text/stamps (patient IDs, hospital names) with high precision,
                anywhere in the frame.
      Pass B - MSER blob detection restricted to the outer 15% margin:
                catches single-character laterality markers ('L'/'R') and
                small glyphs that OCR sometimes misses at low contrast.

    Both passes' boxes are merged and redacted with solid black rectangles.
    """
    out = img.copy()
    h, w = img.shape[:2]
    margin_h, margin_w = int(h * 0.15), int(w * 0.15)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img.copy()

    boxes = []

    # --- Pass A: OCR-based text detection ---
    try:
        data = pytesseract.image_to_data(gray, output_type=pytesseract.Output.DICT,
                                          config="--psm 11")
        for i, txt in enumerate(data["text"]):
            if txt.strip() and int(data["conf"][i]) > 30:
                x, y, rw, rh = (data["left"][i], data["top"][i],
                                 data["width"][i], data["height"][i])
                boxes.append((x, y, rw, rh))
    except Exception:
        pass  # OCR pass is best-effort; MSER pass still runs

    # --- Pass B: MSER blob detection, border-only ---
    mser = cv2.MSER_create()
    mser.setMinArea(20)
    mser.setMaxArea(1500)
    regions, _ = mser.detectRegions(gray)
    for region in regions:
        x, y, rw, rh = cv2.boundingRect(region.reshape(-1, 1, 2))
        in_border = (y < margin_h or y + rh > h - margin_h or
                     x < margin_w or x + rw > w - margin_w)
        plausible_text = 5 < rw < 80 and 8 < rh < 80
        if in_border and plausible_text:
            boxes.append((x, y, rw, rh))

    # --- Merge + redact ---
    redacted_count = 0
    for (x, y, rw, rh) in boxes:
        pad = 4
        x0, y0 = max(0, x - pad), max(0, y - pad)
        x1, y1 = min(w, x + rw + pad), min(h, y + rh + pad)
        cv2.rectangle(out, (x0, y0), (x1, y1), (0, 0, 0), thickness=-1)
        redacted_count += 1

    return out, redacted_count


def process_dataset(input_root: Path, output_root: Path, limit_per_part: int):
    manifest = []
    t0 = time.time()
    total_images = 0
    total_redactions = 0

    for split in ["train", "valid"]:
        split_dir = input_root / split
        if not split_dir.exists():
            continue
        for body_part in BODY_PARTS:
            bp_dir = split_dir / body_part
            if not bp_dir.exists():
                continue
            count_this_part = 0
            for patient_dir in sorted(bp_dir.iterdir()):
                if count_this_part >= limit_per_part:
                    break
                if not patient_dir.is_dir():
                    continue
                anon_id = anon_patient_id(patient_dir.name)
                for study_dir in patient_dir.iterdir():
                    if not study_dir.is_dir():
                        continue
                    for img_path in study_dir.glob("*.png"):
                        img = cv2.imread(str(img_path))
                        if img is None:
                            continue
                        redacted_img, n_redacted = redact_burned_in_text(img)

                        out_dir = (output_root / split / body_part /
                                   anon_id / study_dir.name)
                        out_dir.mkdir(parents=True, exist_ok=True)
                        out_path = out_dir / img_path.name
                        cv2.imwrite(str(out_path), redacted_img)

                        manifest.append({
                            "original_patient": patient_dir.name,
                            "anon_id": anon_id,
                            "body_part": body_part,
                            "split": split,
                            "markers_redacted": n_redacted,
                        })
                        total_images += 1
                        total_redactions += n_redacted
                count_this_part += 1

    elapsed = time.time() - t0
    return manifest, total_images, total_redactions, elapsed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="Path to MURA-v1.1 root")
    ap.add_argument("--output", required=True, help="Path to write anonymized copy")
    ap.add_argument("--limit", type=int, default=200,
                     help="Max patients per body part (for demo speed)")
    args = ap.parse_args()

    input_root = Path(args.input)
    output_root = Path(args.output)
    output_root.mkdir(parents=True, exist_ok=True)

    print(f"[+] Starting MURA anonymization")
    print(f"[+] Input : {input_root}")
    print(f"[+] Output: {output_root}")

    manifest, n_images, n_redactions, elapsed = process_dataset(
        input_root, output_root, args.limit
    )

    print(f"[+] Done. {n_images} images processed in {elapsed:.1f}s "
          f"({n_images/max(elapsed,0.01):.1f} img/s)")
    print(f"[+] Total burned-in markers redacted: {n_redactions}")
    print(f"[+] Anonymized dataset written to: {output_root}")

    # write manifest for audit / panel demo
    import csv
    manifest_path = output_root / "anonymization_manifest.csv"
    with open(manifest_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=manifest[0].keys() if manifest else
                                 ["original_patient", "anon_id", "body_part", "split", "markers_redacted"])
        writer.writeheader()
        writer.writerows(manifest)
    print(f"[+] Manifest written to: {manifest_path}")


if __name__ == "__main__":
    main()

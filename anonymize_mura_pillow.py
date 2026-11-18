"""
MURA X-ray Anonymization Pipeline (Pillow-only fallback)
Objective 1 (image branch) — de-identifies MURA musculoskeletal X-ray images.

This version avoids numpy/opencv entirely (uses only Pillow) so it runs on
HPC environments where those packages don't have prebuilt wheels for the
installed Python version and compiling from source isn't feasible in time.

Anonymization performed:
  1. FILENAME / PATH DE-IDENTIFICATION
     patientXXXXX folder names are replaced with a salted SHA-256 hash,
     deterministic per patient but not reversible.

  2. BURNED-IN MARKER REDACTION
     Uses Tesseract OCR (via pytesseract, if available) to find burned-in
     text in the image and blacks it out. If pytesseract/tesseract isn't
     available either, falls back to redacting fixed corner/border regions
     where markers conventionally appear (documented as a stated limitation
     for the fallback path).

Usage:
    python anonymize_mura_pillow.py --input <MURA_root> --output <anon_root> --limit 200
"""

import argparse
import csv
import hashlib
import time
from pathlib import Path

from PIL import Image, ImageDraw

SALT = "mtech-project-2026-salt"
BODY_PARTS = ["XR_SHOULDER", "XR_HUMERUS", "XR_FINGER", "XR_ELBOW",
              "XR_FOREARM", "XR_HAND", "XR_WRIST"]

try:
    import pytesseract
    OCR_AVAILABLE = True
except ImportError:
    OCR_AVAILABLE = False


def anon_patient_id(patient_folder: str) -> str:
    h = hashlib.sha256((SALT + patient_folder).encode()).hexdigest()[:12]
    return f"ANON-{h}"


def redact_burned_in_text(img: Image.Image):
    """Redact burned-in text/markers. OCR path if available, else border fallback."""
    out = img.copy()
    draw = ImageDraw.Draw(out)
    w, h = img.size
    redacted = 0

    if OCR_AVAILABLE:
        try:
            data = pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT,
                                              config="--psm 11")
            for i, txt in enumerate(data["text"]):
                if txt.strip() and int(data["conf"][i]) > 30:
                    x, y, bw, bh = (data["left"][i], data["top"][i],
                                     data["width"][i], data["height"][i])
                    pad = 4
                    draw.rectangle([x - pad, y - pad, x + bw + pad, y + bh + pad],
                                   fill=(0, 0, 0))
                    redacted += 1
            return out, redacted
        except Exception:
            pass  # fall through to border-region fallback

    # Fallback: redact fixed border-corner regions (documented limitation:
    # less precise than OCR, may redact some non-marker pixels or miss
    # markers outside these fixed zones)
    margin_h, margin_w = int(h * 0.12), int(w * 0.12)
    corners = [
        (0, 0, margin_w, margin_h),                      # top-left
        (w - margin_w, 0, w, margin_h),                  # top-right
        (0, h - margin_h, margin_w, h),                  # bottom-left
        (w - margin_w, h - margin_h, w, h),               # bottom-right
    ]
    for box in corners:
        draw.rectangle(box, fill=(0, 0, 0))
        redacted += 1

    return out, redacted


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
                        img = Image.open(img_path).convert("RGB")
                        redacted_img, n_redacted = redact_burned_in_text(img)

                        out_dir = (output_root / split / body_part /
                                   anon_id / study_dir.name)
                        out_dir.mkdir(parents=True, exist_ok=True)
                        out_path = out_dir / img_path.name
                        redacted_img.save(out_path)

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
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--limit", type=int, default=200)
    args = ap.parse_args()

    input_root = Path(args.input)
    output_root = Path(args.output)
    output_root.mkdir(parents=True, exist_ok=True)

    print(f"[+] Starting MURA anonymization (Pillow-only mode)")
    print(f"[+] OCR available: {OCR_AVAILABLE}")
    print(f"[+] Input : {input_root}")
    print(f"[+] Output: {output_root}")

    manifest, n_images, n_redactions, elapsed = process_dataset(
        input_root, output_root, args.limit
    )

    print(f"[+] Done. {n_images} images processed in {elapsed:.1f}s "
          f"({n_images/max(elapsed,0.01):.1f} img/s)")
    print(f"[+] Total burned-in markers redacted: {n_redactions}")
    print(f"[+] Anonymized dataset written to: {output_root}")

    manifest_path = output_root / "anonymization_manifest.csv"
    if manifest:
        with open(manifest_path, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=manifest[0].keys())
            writer.writeheader()
            writer.writerows(manifest)
        print(f"[+] Manifest written to: {manifest_path}")
    else:
        print("[!] No images found — check --input path")


if __name__ == "__main__":
    main()

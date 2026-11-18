"""
SUPMS-Fair Visualization Script
=================================
Generates 3-panel comparison images for the first 20 benchmark images:
  LEFT:   Original FracAtlas X-ray
  CENTER: Contaminated (synthetic PHI)
  RIGHT:  Anonymized output

Overlays:
  GREEN  = detected & redacted PHI box
  RED    = missed PHI box (not redacted)
  YELLOW = REVIEW-flagged PHI box
  BLUE   = fracture region box

Usage:
    python visualize_results.py [--count 20]
"""

import argparse
import json
from pathlib import Path

import cv2
import numpy as np

# ─────────────────────────────────────────────────────────────────────────────
BASE_DIR   = Path(__file__).parent
ORIGINAL_DIR = BASE_DIR / "original"
CONTAM_DIR   = BASE_DIR / "contaminated"
ANON_DIR     = BASE_DIR / "anonymized"
GT_DIR       = BASE_DIR / "ground_truth"
EVAL_DIR     = BASE_DIR / "evaluation"
VIZ_DIR      = BASE_DIR / "visualizations"
VIZ_DIR.mkdir(parents=True, exist_ok=True)

GREEN  = (0, 200, 0)
RED    = (0, 0, 220)
YELLOW = (0, 200, 220)
BLUE   = (200, 100, 0)
WHITE  = (255, 255, 255)
BLACK  = (0, 0, 0)

THICK  = 2


def load_img(path: Path, max_dim: int = 600) -> np.ndarray:
    img = cv2.imread(str(path))
    if img is None:
        return np.zeros((max_dim, max_dim, 3), dtype=np.uint8)
    h, w = img.shape[:2]
    scale = min(max_dim / w, max_dim / h, 1.0)
    if scale < 1.0:
        img = cv2.resize(img, (int(w * scale), int(h * scale)))
    return img


def draw_boxes(img: np.ndarray, boxes, color, label="", thickness=THICK) -> np.ndarray:
    out = img.copy()
    for b in boxes:
        x1, y1, x2, y2 = int(b[0]), int(b[1]), int(b[2]), int(b[3])
        cv2.rectangle(out, (x1, y1), (x2, y2), color, thickness)
        if label:
            cv2.putText(out, label, (x1, max(0, y1 - 4)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.4, color, 1)
    return out


def add_title_bar(img: np.ndarray, title: str, height: int = 30) -> np.ndarray:
    bar = np.zeros((height, img.shape[1], 3), dtype=np.uint8)
    bar[:] = (50, 50, 50)
    cv2.putText(bar, title, (6, height - 8),
                cv2.FONT_HERSHEY_SIMPLEX, 0.55, WHITE, 1)
    return np.vstack([bar, img])


def compute_iou(a, b):
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    if inter == 0:
        return 0.0
    area_a = (a[2]-a[0]) * (a[3]-a[1])
    area_b = (b[2]-b[0]) * (b[3]-b[1])
    return inter / (area_a + area_b - inter + 1e-6)


def run(count: int = 20, iou_thresh: float = 0.50):
    # Load ground truth
    gt_file = GT_DIR / "annotations.json"
    if not gt_file.exists():
        print("ERROR: Run generate_synthetic_phi.py first")
        return
    with open(gt_file) as f:
        all_gt = json.load(f)
    gt_map = {a["image_id"]: a for a in all_gt}

    # Load per-image evaluation results if available
    eval_results_file = EVAL_DIR / "evaluation_results.csv"
    eval_map = {}
    if eval_results_file.exists():
        import csv
        with open(eval_results_file) as f:
            for row in csv.DictReader(f):
                eval_map[row["image_id"]] = row

    done = 0
    for gt_ann in all_gt[:count]:
        image_id    = gt_ann["image_id"]
        stem        = image_id.replace(".jpg", "")
        orig_path   = ORIGINAL_DIR  / image_id
        contam_path = CONTAM_DIR    / f"{stem}_phi.jpg"
        anon_path   = ANON_DIR      / f"{stem}_anon.jpg"

        if not orig_path.exists():
            continue

        max_dim = 540

        # Load panels
        orig_img   = load_img(orig_path,   max_dim)
        contam_img = load_img(contam_path, max_dim) if contam_path.exists() else orig_img.copy()
        anon_img   = load_img(anon_path,   max_dim) if anon_path.exists() else np.zeros_like(orig_img)

        # Scale factor for box coordinates (original image might be larger)
        try:
            from PIL import Image as PILImage
            pil_tmp = PILImage.open(orig_path)
            iw, ih  = pil_tmp.size
            pil_tmp.close()
        except Exception:
            ih, iw = orig_img.shape[:2]

        scale_x = orig_img.shape[1] / iw
        scale_y = orig_img.shape[0] / ih

        def scale_box(b):
            return [int(b[0]*scale_x), int(b[1]*scale_y),
                    int(b[2]*scale_x), int(b[3]*scale_y)]

        # GT boxes
        gt_fields     = gt_ann["fields"]
        gt_boxes_orig = [f["bbox"] for f in gt_fields]
        gt_boxes      = [scale_box(b) for b in gt_boxes_orig]
        frac_boxes    = [scale_box(b) for b in gt_ann["fracture_boxes_pixel"]]

        # Overlay GT boxes on contaminated image
        for gb in gt_boxes:
            contam_img = draw_boxes(contam_img, [gb], YELLOW, thickness=1)

        # Overlay fracture boxes on original & contaminated
        for fb in frac_boxes:
            orig_img   = draw_boxes(orig_img,   [fb], BLUE, label="FX")
            contam_img = draw_boxes(contam_img, [fb], BLUE)

        # On anonymized image: show green/red/yellow based on whether GT boxes were redacted
        if anon_path.exists():
            per_img_eval = eval_map.get(image_id, {})
            # Without per-box result we just show GT overlaid on anon image
            for fi, (gb, gf) in enumerate(zip(gt_boxes, gt_fields)):
                # If evaluation results available, color accordingly
                if per_img_eval:
                    tp = int(per_img_eval.get("tp50", 0))
                    fn = int(per_img_eval.get("fn50", 0))
                    # Approximate: if field index < tp, assume detected
                    color = GREEN if fi < tp else RED
                else:
                    color = YELLOW
                anon_img = draw_boxes(anon_img, [gb], color)
            for fb in frac_boxes:
                anon_img = draw_boxes(anon_img, [fb], BLUE)

        # Add title bars
        overlap_tag = "FRAC-OVERLAP" if gt_ann["has_fracture_overlap"] else "NO-OVERLAP"
        orig_panel   = add_title_bar(orig_img,   f"ORIGINAL  [{image_id}] [{overlap_tag}]")
        contam_panel = add_title_bar(contam_img, f"CONTAMINATED  GT={len(gt_boxes)} PHI fields")
        anon_panel   = add_title_bar(anon_img,   f"ANONYMIZED  (GREEN=detected RED=missed BLUE=fracture)")

        # Make all panels same height
        max_h = max(orig_panel.shape[0], contam_panel.shape[0], anon_panel.shape[0])
        def pad_h(img, target_h):
            if img.shape[0] < target_h:
                pad = np.zeros((target_h - img.shape[0], img.shape[1], 3), dtype=np.uint8)
                img = np.vstack([img, pad])
            return img

        orig_panel   = pad_h(orig_panel,   max_h)
        contam_panel = pad_h(contam_panel, max_h)
        anon_panel   = pad_h(anon_panel,   max_h)

        # Add 4-px white separator
        sep = np.ones((max_h, 4, 3), dtype=np.uint8) * 200
        combined = np.hstack([orig_panel, sep, contam_panel, sep, anon_panel])

        out_path = VIZ_DIR / f"{stem}_comparison.jpg"
        cv2.imwrite(str(out_path), combined, [cv2.IMWRITE_JPEG_QUALITY, 90])
        print(f"  Saved: {out_path.name}")
        done += 1

    print(f"\n  {done} visualizations saved to {VIZ_DIR}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=20)
    parser.add_argument("--iou-threshold", type=float, default=0.50)
    args = parser.parse_args()
    run(count=args.count, iou_thresh=args.iou_threshold)

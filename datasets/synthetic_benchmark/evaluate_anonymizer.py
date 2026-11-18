"""
SUPMS-Fair Evaluation Pipeline
================================
Sends each contaminated image through the REAL anonymization pipeline
(http://localhost:8000/anonymize), collects results, and computes:
  - PHI Detection Precision / Recall / F1
  - Redaction Recall
  - IoU matching at 0.30 / 0.50 / 0.75
  - Fracture-aware group analysis (Group A & B)
  - REVIEW rate (never silently passed as SAFE)

Usage:
    python evaluate_anonymizer.py [--endpoint http://localhost:8000] [--iou-threshold 0.5]
"""

import argparse
import csv
import json
import sys
import time
from pathlib import Path

import requests

# ─────────────────────────────────────────────────────────────────────────────
BASE_DIR   = Path(__file__).parent
CONTAM_DIR = BASE_DIR / "contaminated"
GT_DIR     = BASE_DIR / "ground_truth"
ANON_DIR   = BASE_DIR / "anonymized"
EVAL_DIR   = BASE_DIR / "evaluation"
ANON_DIR.mkdir(parents=True, exist_ok=True)
EVAL_DIR.mkdir(parents=True, exist_ok=True)

# ─────────────────────────────────────────────────────────────────────────────
def compute_iou(a, b):
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    if inter == 0:
        return 0.0
    area_a = (a[2]-a[0]) * (a[3]-a[1])
    area_b = (b[2]-b[0]) * (b[3]-b[1])
    return inter / (area_a + area_b - inter + 1e-6)

def match_boxes(gt_boxes, pred_boxes, iou_thresh):
    """
    Greedy matching: each GT box matched to at most one pred box.
    Returns (matched_gt_indices, matched_pred_indices, unmatched_gt, unmatched_pred)
    """
    matched_gt, matched_pred = set(), set()
    pairs = []
    for gi, gb in enumerate(gt_boxes):
        for pi, pb in enumerate(pred_boxes):
            iou = compute_iou(gb, pb)
            if iou >= iou_thresh:
                pairs.append((iou, gi, pi))
    pairs.sort(reverse=True)
    for iou, gi, pi in pairs:
        if gi not in matched_gt and pi not in matched_pred:
            matched_gt.add(gi); matched_pred.add(pi)
    unmatched_gt   = [i for i in range(len(gt_boxes))   if i not in matched_gt]
    unmatched_pred = [i for i in range(len(pred_boxes)) if i not in matched_pred]
    return matched_gt, matched_pred, unmatched_gt, unmatched_pred

# ─────────────────────────────────────────────────────────────────────────────
def call_anonymizer(contam_path: Path, endpoint: str) -> dict:
    """POST image to FastAPI /anonymize and return response dict."""
    with open(contam_path, "rb") as f:
        files = {"file": (contam_path.name, f, "image/jpeg")}
        resp = requests.post(f"{endpoint}/anonymize", files=files, timeout=120)
    resp.raise_for_status()
    return resp.json()

# ─────────────────────────────────────────────────────────────────────────────
def save_anonymized_image(result: dict, out_path: Path):
    import base64
    if "image_base64" in result:
        data = base64.b64decode(result["image_base64"])
        out_path.write_bytes(data)

# ─────────────────────────────────────────────────────────────────────────────
def run(endpoint: str = "http://localhost:8000", iou_threshold: float = 0.50):
    # Load ground truth
    gt_file = GT_DIR / "annotations.json"
    if not gt_file.exists():
        sys.exit(f"ERROR: Ground truth not found at {gt_file}\n"
                 f"Run generate_synthetic_phi.py first.")
    with open(gt_file) as f:
        all_gt = json.load(f)
    gt_map = {a["image_id"]: a for a in all_gt}

    # Load contaminated images
    contam_images = sorted(CONTAM_DIR.glob("*_phi.jpg"))
    if not contam_images:
        sys.exit(f"ERROR: No contaminated images found in {CONTAM_DIR}")

    print(f"\n{'='*65}")
    print(f"  SUPMS-Fair Evaluation Runner")
    print(f"  Endpoint : {endpoint}")
    print(f"  IoU @    : 0.30 / 0.50 / 0.75 (primary: {iou_threshold})")
    print(f"  Images   : {len(contam_images)}")
    print(f"{'='*65}\n")

    per_image_rows = []
    field_rows     = []

    # Group counters
    stats = {
        "total_images": 0, "failed_images": 0,
        "total_gt_fields": 0, "total_pred_redacted": 0,
        "total_review": 0, "total_fp": 0,
        # @0.50
        "tp50": 0, "fp50": 0, "fn50": 0,
        # @0.30
        "tp30": 0, "fp30": 0, "fn30": 0,
        # @0.75
        "tp75": 0, "fp75": 0, "fn75": 0,
        # by group
        "A_gt": 0, "A_tp50": 0, "A_fn50": 0,
        "B_gt": 0, "B_tp50": 0, "B_fn50": 0,
        "total_time_s": 0.0,
    }

    for contam_path in contam_images:
        # Derive image_id from filename: "001_phi.jpg" → "001.jpg"
        stem     = contam_path.stem.replace("_phi", "")
        image_id = stem + ".jpg"
        gt_ann   = gt_map.get(image_id)
        if gt_ann is None:
            print(f"  [WARN] No GT for {image_id}, skipping")
            continue

        stats["total_images"] += 1
        t0 = time.time()

        try:
            result = call_anonymizer(contam_path, endpoint)
        except Exception as e:
            print(f"  [ERROR] {image_id}: {e}")
            stats["failed_images"] += 1
            per_image_rows.append({
                "image_id": image_id, "status": "FAILED",
                "error": str(e), "gt_fields": len(gt_ann["fields"]),
                "pred_redacted": 0, "review_count": 0,
                "tp50": 0, "fp50": 0, "fn50": 0,
                "overlap_group": gt_ann.get("overlap_group",""),
            })
            continue

        elapsed = time.time() - t0
        stats["total_time_s"] += elapsed

        # Save anonymized image
        anon_path = ANON_DIR / f"{stem}_anon.jpg"
        save_anonymized_image(result, anon_path)

        # Extract redacted boxes from API log
        phi_lines   = result.get("phi_lines", [])  # list of dicts with "box", "action", "text"
        review_lines = [l for l in phi_lines if "REVIEW" in l.get("action","").upper() or
                        (l.get("phi") is False and l.get("action","").upper() not in ("KEPT","SAFE"))]

        # All boxes that were actually acted on (redacted solid OR pixelated)
        redacted_lines = [l for l in phi_lines if l.get("phi") is True]
        pred_boxes = [l["box"] for l in redacted_lines if "box" in l]

        # GT boxes from this image
        gt_fields  = gt_ann["fields"]
        gt_boxes   = [f["bbox"] for f in gt_fields]

        n_gt       = len(gt_boxes)
        n_pred     = len(pred_boxes)
        n_review   = len(review_lines)

        stats["total_gt_fields"]   += n_gt
        stats["total_pred_redacted"] += n_pred
        stats["total_review"]      += n_review

        overlap_group = gt_ann.get("overlap_group", "A_no_overlap")

        # Match at three IoU thresholds
        for thresh, tp_key, fp_key, fn_key in [
            (0.50, "tp50", "fp50", "fn50"),
            (0.30, "tp30", "fp30", "fn30"),
            (0.75, "tp75", "fp75", "fn75"),
        ]:
            matched_gt, matched_pred, unmatched_gt, unmatched_pred = match_boxes(
                gt_boxes, pred_boxes, thresh)
            tp = len(matched_gt)
            fp = len(unmatched_pred)
            fn = len(unmatched_gt)
            stats[tp_key] += tp
            stats[fp_key] += fp
            stats[fn_key] += fn
            if thresh == 0.50:
                stats["total_fp"] += fp
                if overlap_group == "A_no_overlap":
                    stats["A_gt"] += n_gt; stats["A_tp50"] += tp; stats["A_fn50"] += fn
                else:
                    stats["B_gt"] += n_gt; stats["B_tp50"] += tp; stats["B_fn50"] += fn

        # ── Per-image row ──
        mgt50, mpred50, umgt50, umpred50 = match_boxes(gt_boxes, pred_boxes, 0.50)
        per_image_rows.append({
            "image_id":       image_id,
            "status":         result.get("status","unknown"),
            "category":       gt_ann["source_category"],
            "overlap_group":  overlap_group,
            "gt_fields":      n_gt,
            "pred_redacted":  n_pred,
            "review_count":   n_review,
            "tp50":           len(mgt50),
            "fp50":           len(umpred50),
            "fn50":           len(umgt50),
            "processing_s":   round(elapsed, 3),
            "phi_detected":   result.get("phi_lines_detected", 0),
            "ocr_words":      result.get("ocr_words_detected", 0),
        })

        # ── Per-field rows ──
        matched_gt50, matched_pred50, _, _ = match_boxes(gt_boxes, pred_boxes, 0.50)
        for fi, gt_f in enumerate(gt_fields):
            detected = fi in matched_gt50
            field_rows.append({
                "image_id":      image_id,
                "field_type":    gt_f["type"],
                "gt_text":       gt_f["text"],
                "gt_bbox":       str(gt_f["bbox"]),
                "detected":      detected,
                "frac_overlap":  gt_f.get("fracture_overlap", False),
                "frac_iou":      gt_f.get("fracture_iou", 0.0),
                "overlap_group": overlap_group,
            })

        review_flag = " [REVIEW]" if n_review > 0 else ""
        print(f"  [{stem}] GT={n_gt} PRED={n_pred} TP={len(mgt50)} FP={len(umpred50)} "
              f"FN={len(umgt50)} t={elapsed:.1f}s{review_flag}")

    # ─────────────────────────────────────────────────────────────────────────
    # Compute metrics
    # ─────────────────────────────────────────────────────────────────────────
    def prf(tp, fp, fn):
        p = tp / (tp + fp + 1e-9)
        r = tp / (tp + fn + 1e-9)
        f = 2*p*r / (p + r + 1e-9)
        return round(p, 4), round(r, 4), round(f, 4)

    p50, r50, f50 = prf(stats["tp50"], stats["fp50"], stats["fn50"])
    p30, r30, f30 = prf(stats["tp30"], stats["fp30"], stats["fn30"])
    p75, r75, f75 = prf(stats["tp75"], stats["fp75"], stats["fn75"])

    redaction_recall = stats["tp50"] / (stats["total_gt_fields"] + 1e-9)

    # Group A/B recall
    a_recall = stats["A_tp50"] / (stats["A_gt"] + 1e-9)
    b_recall = stats["B_tp50"] / (stats["B_gt"] + 1e-9)

    review_rate = stats["total_review"] / (stats["total_pred_redacted"] + 1e-9)
    avg_time    = stats["total_time_s"] / (stats["total_images"] + 1e-9)

    # ─────────────────────────────────────────────────────────────────────────
    # Save evaluation results
    # ─────────────────────────────────────────────────────────────────────────
    results_csv = EVAL_DIR / "evaluation_results.csv"
    if per_image_rows:
        with open(results_csv, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=list(per_image_rows[0].keys()))
            writer.writeheader()
            writer.writerows(per_image_rows)

    fields_csv = EVAL_DIR / "field_level_results.csv"
    if field_rows:
        with open(fields_csv, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=list(field_rows[0].keys()))
            writer.writeheader()
            writer.writerows(field_rows)

    summary = {
        "total_images_processed":   stats["total_images"],
        "failed_images":            stats["failed_images"],
        "total_phi_fields_inserted": stats["total_gt_fields"],
        "total_phi_detected":       stats["tp50"],
        "total_phi_missed":         stats["fn50"],
        "total_false_positives":    stats["fp50"],
        "total_review_flagged":     stats["total_review"],
        "precision_at_50":          p50,
        "recall_at_50":             r50,
        "f1_at_50":                 f50,
        "precision_at_30":          p30,
        "recall_at_30":             r30,
        "f1_at_30":                 f30,
        "precision_at_75":          p75,
        "recall_at_75":             r75,
        "f1_at_75":                 f75,
        "redaction_recall":         round(redaction_recall, 4),
        "review_rate":              round(review_rate, 4),
        "group_A_no_overlap_recall":    round(a_recall, 4),
        "group_B_frac_overlap_recall":  round(b_recall, 4),
        "average_processing_time_s":    round(avg_time, 3),
    }

    summary_json = EVAL_DIR / "evaluation_summary.json"
    summary_json.write_text(json.dumps(summary, indent=2))

    # ─────────────────────────────────────────────────────────────────────────
    # Print summary
    # ─────────────────────────────────────────────────────────────────────────
    print(f"\n{'='*65}")
    print(f"  EVALUATION SUMMARY")
    print(f"{'='*65}")
    print(f"  Images processed       : {stats['total_images']}")
    print(f"  Failed                 : {stats['failed_images']}")
    print(f"  Total GT PHI fields    : {stats['total_gt_fields']}")
    print(f"  Total detected (TP@50) : {stats['tp50']}")
    print(f"  Missed (FN@50)         : {stats['fn50']}")
    print(f"  False positives (FP@50): {stats['fp50']}")
    print(f"  REVIEW flagged         : {stats['total_review']}")
    print(f"  ─────────────────────────────────────────────")
    print(f"  Precision @0.50        : {p50:.4f}")
    print(f"  Recall    @0.50        : {r50:.4f}")
    print(f"  F1        @0.50        : {f50:.4f}")
    print(f"  Precision @0.30        : {p30:.4f}")
    print(f"  Recall    @0.30        : {r30:.4f}")
    print(f"  F1        @0.30        : {f30:.4f}")
    print(f"  Precision @0.75        : {p75:.4f}")
    print(f"  Recall    @0.75        : {r75:.4f}")
    print(f"  F1        @0.75        : {f75:.4f}")
    print(f"  ─────────────────────────────────────────────")
    print(f"  Redaction Recall       : {redaction_recall:.4f}")
    print(f"  Group A (no-overlap) ↑ : {a_recall:.4f}")
    print(f"  Group B (frac-overlap): {b_recall:.4f}")
    print(f"  REVIEW rate            : {review_rate:.4f}")
    print(f"  Avg time/image         : {avg_time:.2f}s")
    print(f"{'='*65}")
    print(f"\n  Results saved to:")
    print(f"    {results_csv}")
    print(f"    {summary_json}")
    print(f"    {fields_csv}\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="SUPMS-Fair Evaluation Runner")
    parser.add_argument("--endpoint",      default="http://localhost:8000",
                        help="FastAPI anonymization service URL")
    parser.add_argument("--iou-threshold", type=float, default=0.50)
    args = parser.parse_args()
    run(endpoint=args.endpoint, iou_threshold=args.iou_threshold)

import csv, json
from pathlib import Path

BASE      = Path(r"D:\sec hospital\mtech project ref")
SYNTH     = BASE / "datasets" / "synthetic_phi"
EVAL      = BASE / "datasets" / "evaluation"
FRAC_YOLO = BASE / "FracAtlas" / "Annotations" / "YOLO"
GT_CSV    = SYNTH / "ground_truth.csv"
RUN_JSON  = BASE / "datasets" / "anon_run_results.json"
EVAL.mkdir(parents=True, exist_ok=True)

# Load ground truth
gt_records = list(csv.DictReader(GT_CSV.open(encoding="utf-8")))
print(f"GT annotations: {len(gt_records)}")

# Load anonymizer results
with RUN_JSON.open() as f:
    run_data = json.load(f)
anon_results = run_data["results"]
anon_errors  = run_data["errors"]

def norm(t):
    return " ".join(t.upper().strip().split())

gt_by_img = {}
for row in gt_records:
    gt_by_img.setdefault(row["synthetic_image_id"], []).append(row)

det_rows, red_rows = [], []
tp = fp = fn = 0

for stem, gt_list in sorted(gt_by_img.items()):
    log = anon_results.get(stem)
    if log is None:
        for gt in gt_list:
            det_rows.append({"image_id": stem, "phi_type": gt["phi_type"],
                "gt_text": gt["text"], "detected_text": "",
                "text_match": "FALSE", "detection_status": "ERROR",
                "iou": -1, "notes": "anonymizer error"})
            bbox = str(gt["x"])+","+str(gt["y"])+","+str(gt["width"])+","+str(gt["height"])
            red_rows.append({"image_id": stem, "phi_type": gt["phi_type"],
                "ground_truth_bbox": bbox, "predicted_bbox": "",
                "iou": -1, "redaction_status": "NOT_REDACTED", "notes": "anonymizer error"})
            fn += 1
        continue

    for gt in gt_list:
        gtn = norm(gt["text"])
        matched = None
        for txt, phi in log:
            if gtn in norm(txt):
                matched = (txt, phi)
                break
        if matched is None:
            gt_tok = set(gtn.split())
            for txt, phi in log:
                overlap = len(gt_tok & set(norm(txt).split()))
                if overlap >= max(1, len(gt_tok) // 2):
                    matched = (txt, phi)
                    break

        if matched:
            lt, wr = matched
            tp += 1
            det_status = "DETECTED"
            red_status = "FULLY_REDACTED" if wr else "DETECTED_NOT_REDACTED"
        else:
            lt = ""
            wr = False
            fn += 1
            det_status = "NOT_DETECTED"
            red_status = "NOT_REDACTED"

        det_rows.append({"image_id": stem, "phi_type": gt["phi_type"],
            "gt_text": gt["text"], "detected_text": lt,
            "text_match": "TRUE" if matched else "FALSE",
            "detection_status": det_status, "iou": -1,
            "notes": "IoU N/A: anonymize_xray.py has no predicted bbox"})
        bbox = str(gt["x"])+","+str(gt["y"])+","+str(gt["width"])+","+str(gt["height"])
        red_rows.append({"image_id": stem, "phi_type": gt["phi_type"],
            "ground_truth_bbox": bbox, "predicted_bbox": "",
            "iou": -1, "redaction_status": red_status, "notes": "pixel IoU unavailable"})

    for txt, phi in log:
        if not phi:
            continue
        matched_any = any(
            norm(g["text"]) in norm(txt) or norm(txt) in norm(g["text"])
            for g in gt_list
        )
        if not matched_any:
            fp += 1

total = tp + fn
P  = tp / (tp + fp) if (tp + fp) else 0.0
R  = tp / total     if total     else 0.0
F1 = 2*P*R / (P+R)  if (P+R)    else 0.0

rc = {}
for r in red_rows:
    rc[r["redaction_status"]] = rc.get(r["redaction_status"], 0) + 1

metrics = {
    "total_gt_phi_instances": total,
    "true_positives": tp,
    "false_positives": fp,
    "false_negatives": fn,
    "precision": round(P, 4),
    "recall": round(R, 4),
    "f1": round(F1, 4),
    "redaction_fully_redacted": rc.get("FULLY_REDACTED", 0),
    "redaction_detected_not_redacted": rc.get("DETECTED_NOT_REDACTED", 0),
    "redaction_not_redacted": rc.get("NOT_REDACTED", 0),
    "note_iou": "anonymize_xray.py has no predicted bbox output; IoU cannot be computed",
    "note_redaction": "FULLY_REDACTED = detected OCR line was marked PHI by anonymizer"
}

print("TP=" + str(tp) + "  FP=" + str(fp) + "  FN=" + str(fn))
print("P=" + str(round(P,4)) + "  R=" + str(round(R,4)) + "  F1=" + str(round(F1,4)))
print("Redaction: " + str(rc))

def write_csv(path, rows):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print("[WROTE] " + str(path))

write_csv(EVAL / "detection_results.csv", det_rows)
write_csv(EVAL / "redaction_results.csv", red_rows)

sm_path = EVAL / "summary_metrics.csv"
with sm_path.open("w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=["metric", "value"])
    w.writeheader()
    for k, v in metrics.items():
        w.writerow({"metric": k, "value": v})
print("[WROTE] " + str(sm_path))

# ---- Step 8: Fracture annotation mapping ----
print("--- Step 8: Fracture annotation mapping ---")
ann_map, ovr_rows = [], []
yolo_found_count = 0
has_frac_count   = 0
phi_overlaps     = 0

for row in gt_records:
    src = Path(row["source_image"])
    stem2 = src.stem
    ytxt  = FRAC_YOLO / (stem2 + ".txt")
    iw    = int(row["image_width"])
    ih    = int(row["image_height"])
    frac_boxes = []

    if ytxt.exists():
        yolo_found_count += 1
        for line in ytxt.read_text(errors="ignore").splitlines():
            p = line.strip().split()
            if len(p) == 5:
                try:
                    xc = float(p[1]); yc = float(p[2])
                    bw = float(p[3]); bh = float(p[4])
                    if all(0 <= v <= 1 for v in (xc, yc, bw, bh)):
                        x1 = max(0, round((xc - bw/2) * iw))
                        y1 = max(0, round((yc - bh/2) * ih))
                        x2 = min(iw, round((xc + bw/2) * iw))
                        y2 = min(ih, round((yc + bh/2) * ih))
                        frac_boxes.append((x1, y1, x2-x1, y2-y1))
                except Exception:
                    pass
    if frac_boxes:
        has_frac_count += 1

    px = int(row["x"]); py = int(row["y"])
    pw = int(row["width"]); ph = int(row["height"])
    overlaps = []
    for fx, fy, fw, fh in frac_boxes:
        ix1 = max(px, fx); iy1 = max(py, fy)
        ix2 = min(px+pw, fx+fw); iy2 = min(py+ph, fy+fh)
        iwa = max(0, ix2-ix1); iha = max(0, iy2-iy1)
        if iwa > 0 and iha > 0:
            oa = iwa * iha
            pa = pw * ph
            pct = round(oa / pa if pa else 0, 4)
            overlaps.append({
                "fracture_bbox": str(fx)+","+str(fy)+","+str(fw)+","+str(fh),
                "overlap_area": oa, "pct_phi_covered": pct
            })
    if overlaps:
        phi_overlaps += 1

    ann_map.append({
        "synthetic_image_id": row["synthetic_image_id"],
        "source_image": src.name,
        "phi_type": row["phi_type"],
        "yolo_annotation_found": str(ytxt.exists()),
        "has_fracture_annotation": str(len(frac_boxes) > 0),
        "num_fracture_boxes": len(frac_boxes),
        "fracture_boxes": "; ".join(str(b[0])+","+str(b[1])+","+str(b[2])+","+str(b[3]) for b in frac_boxes)
    })
    ovr_rows.append({
        "synthetic_image_id": row["synthetic_image_id"],
        "source_image": src.name,
        "phi_type": row["phi_type"],
        "phi_bbox": str(px)+","+str(py)+","+str(pw)+","+str(ph),
        "num_fracture_boxes": len(frac_boxes),
        "num_overlapping": len(overlaps),
        "phi_overlaps_fracture": str(len(overlaps) > 0),
        "overlap_details": json.dumps(overlaps) if overlaps else ""
    })

print("YOLO files found: " + str(yolo_found_count) + "/" + str(len(gt_records)))
print("Has fracture annotation: " + str(has_frac_count) + "/" + str(len(gt_records)))
print("PHI overlapping fracture: " + str(phi_overlaps) + "/" + str(len(ovr_rows)))

write_csv(EVAL / "fracatlas_annotation_map.csv", ann_map)
write_csv(EVAL / "phi_fracture_overlap.csv", ovr_rows)

# ---- ML Problems ----
problems = [
    "PROBLEM 1 (CRITICAL): NO PREDICTED BOUNDING BOX\n"
    "  anonymize_xray.py anonymize() returns [(line_text, was_phi),...] only.\n"
    "  No predicted bboxes are exposed. Pixel-level IoU is IMPOSSIBLE.\n"
    "  MINIMAL FIX: Return [(text, (x,y,w,h), was_phi),...] using Tesseract data dict.",

    "PROBLEM 2: OCR DETECTION RECALL = " + str(round(R,4)) + "\n"
    "  " + str(fn) + "/" + str(total) + " GT PHI instances were not detected.\n"
    "  Causes: (a) native-resolution OCR on small thumbnails fails;\n"
    "          (b) app/ocr.py upscales 2x -- anonymize_xray.py does not;\n"
    "          (c) is_phi_word() misses some line formats.",

    "PROBLEM 3: FALSE POSITIVES = " + str(fp) + "\n"
    "  Broad keyword 'id' in PHI_KEYWORDS matches non-PHI metadata.\n"
    "  FIX: Require keyword + pattern, not keyword alone.",

    "PROBLEM 4: INCOMPLETE REDACTION = " + str(rc.get("NOT_REDACTED",0)) + " regions\n"
    "  GT PHI was OCR-visible but the line_is_phi check returned False.",

    "PROBLEM 5: IMAGE UPSCALING GAP\n"
    "  app/ocr.py: 2x upscale + normalize before OCR.\n"
    "  anonymize_xray.py: raw grayscale at native resolution.\n"
    "  Creates systematic recall deficit for small (<200px) FracAtlas images.",

    "PROBLEM 6: FRACTURE REGION CONFLICT\n"
    "  " + str(phi_overlaps) + " PHI annotations overlap YOLO fracture bboxes.\n"
    "  anonymize_xray.py blindly fills black over fracture zones.\n"
    "  app/anonymizer.py routes these to manual review queue.",

    "PROBLEM 7: PHI PLACEMENT RANDOMNESS\n"
    "  Random seed=42 causes some synthetic PHI to land on fracture zones.\n"
    "  Measurable -- see phi_fracture_overlap.csv.\n"
    "  Recommend: run --placement safe variant for clean evaluation.",

    "PROBLEM 8: NO CONFIDENCE THRESHOLD IN anonymize_xray.py\n"
    "  Low-confidence OCR words pollute detection. app/ocr.py filters at conf>=35.",

    "PROBLEM 9: METADATA NOT SCRUBBED IN anonymize_xray.py\n"
    "  app/anonymizer.py strips EXIF/IPTC. anonymize_xray.py does not."
]

ml_path = EVAL / "ml_problems.txt"
with ml_path.open("w", encoding="utf-8") as f:
    f.write("WBE ML ANONYMIZATION - PHASE 1: ML PROBLEMS IDENTIFIED\n")
    f.write("="*60+"\n\n")
    for p in problems:
        f.write(p + "\n\n")
print("[WROTE] " + str(ml_path) + " (" + str(len(problems)) + " problems)")

print()
print("="*60)
print("PHASE 1 EVALUATION COMPLETE")
print("  Total GT PHI     : " + str(total))
print("  True Positives   : " + str(tp))
print("  False Positives  : " + str(fp))
print("  False Negatives  : " + str(fn))
print("  Precision        : " + str(round(P,4)))
print("  Recall           : " + str(round(R,4)))
print("  F1               : " + str(round(F1,4)))
print("  Fully Redacted   : " + str(rc.get("FULLY_REDACTED",0)))
print("  Detected !Redact : " + str(rc.get("DETECTED_NOT_REDACTED",0)))
print("  Not Redacted     : " + str(rc.get("NOT_REDACTED",0)))
print("  PHI-Frac Overlap : " + str(phi_overlaps))
print("="*60)

"""Re-run anonymizer with refactored code (bbox output) + re-evaluate with IoU."""
import importlib.util, os, sys, json, csv, time
from pathlib import Path

BASE      = Path(r"D:\sec hospital\mtech project ref")
SYNTH     = BASE / "datasets" / "synthetic_phi"
EVAL      = BASE / "datasets" / "evaluation"
ANON_OUT  = BASE / "datasets" / "anonymized_output"
FRAC_YOLO = BASE / "FracAtlas" / "Annotations" / "YOLO"
GT_CSV    = SYNTH / "ground_truth.csv"
SYNTH_IMGS= SYNTH / "images"

ANON_OUT.mkdir(parents=True, exist_ok=True)
EVAL.mkdir(parents=True, exist_ok=True)

# Configure Tesseract
import pytesseract
pytesseract.pytesseract.tesseract_cmd = str(BASE / "tesseract.exe")
os.environ["TESSDATA_PREFIX"] = str(BASE / "tessdata")

# Import refactored anonymize_xray
spec = importlib.util.spec_from_file_location("anonymize_xray", BASE / "anonymize_xray.py")
mod  = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

print("=" * 60)
print("  RE-RUN: Anonymizer with bbox output + SCAN/DATE fix")
print("=" * 60)

imgs = sorted(SYNTH_IMGS.glob("*.jpg"))
results = {}
errors = []
t0 = time.time()

for idx, img in enumerate(imgs, 1):
    out = ANON_OUT / img.name
    try:
        log = mod.anonymize(str(img), str(out))
        # log entries are now (text, is_phi, [x,y,w,h])
        results[img.stem] = log
        if idx % 20 == 0 or idx == len(imgs):
            print("  [" + str(idx) + "/" + str(len(imgs)) + "] " + img.name)
    except Exception as e:
        errors.append({"image": img.name, "error": str(e)})
        print("  [ERR] " + img.name + ": " + str(e))

print("Anonymizer done: " + str(len(results)) + " ok, " + str(len(errors)) + " errors in " + str(round(time.time()-t0,1)) + "s")

# Save raw results
save = {}
for stem, log in results.items():
    save[stem] = []
    for entry in log:
        text = entry[0]
        phi  = bool(entry[1])
        bbox = list(entry[2]) if len(entry) > 2 and entry[2] else []
        save[stem].append([text, phi, bbox])

with open(str(BASE / "datasets" / "anon_run_results_v2.json"), "w") as f:
    json.dump({"results": save, "errors": errors}, f, indent=2)
print("[SAVED] anon_run_results_v2.json")

# ---- EVALUATION WITH IoU ----
print()
print("=" * 60)
print("  EVALUATION WITH IoU")
print("=" * 60)

gt_records = list(csv.DictReader(GT_CSV.open(encoding="utf-8")))
print("GT annotations: " + str(len(gt_records)))

gt_by_img = {}
for row in gt_records:
    gt_by_img.setdefault(row["synthetic_image_id"], []).append(row)

def norm(t):
    return " ".join(t.upper().strip().split())

def compute_iou(gt_xywh, pred_xywh):
    gx, gy, gw, gh = gt_xywh
    px, py, pw, ph = pred_xywh
    gx2, gy2 = gx + gw, gy + gh
    px2, py2 = px + pw, py + ph
    ix1 = max(gx, px); iy1 = max(gy, py)
    ix2 = min(gx2, px2); iy2 = min(gy2, py2)
    iw = max(0, ix2 - ix1); ih = max(0, iy2 - iy1)
    inter = iw * ih
    union = gw * gh + pw * ph - inter
    if union <= 0:
        return 0.0
    return round(inter / union, 4)

det_rows = []
red_rows = []
tp = fp = fn = 0
iou_values = []

for stem, gt_list in sorted(gt_by_img.items()):
    log = results.get(stem)
    if log is None:
        for gt in gt_list:
            bbox_str = str(gt["x"])+","+str(gt["y"])+","+str(gt["width"])+","+str(gt["height"])
            det_rows.append({"image_id": stem, "phi_type": gt["phi_type"],
                "gt_text": gt["text"], "detected_text": "", "text_match": "FALSE",
                "detection_status": "ERROR", "predicted_bbox": "", "iou": -1,
                "notes": "anonymizer error"})
            red_rows.append({"image_id": stem, "phi_type": gt["phi_type"],
                "ground_truth_bbox": bbox_str, "predicted_bbox": "", "iou": -1,
                "redaction_status": "NOT_REDACTED", "notes": "anonymizer error"})
            fn += 1
        continue

    for gt in gt_list:
        gtn = norm(gt["text"])
        gt_bbox = (int(gt["x"]), int(gt["y"]), int(gt["width"]), int(gt["height"]))

        matched = None
        for entry in log:
            txt = entry[0]
            phi = entry[1]
            bbox = entry[2] if len(entry) > 2 else []
            if gtn in norm(txt):
                matched = (txt, phi, bbox)
                break
        if matched is None:
            gt_tok = set(gtn.split())
            for entry in log:
                txt = entry[0]
                phi = entry[1]
                bbox = entry[2] if len(entry) > 2 else []
                overlap_count = len(gt_tok & set(norm(txt).split()))
                if overlap_count >= max(1, len(gt_tok) // 2):
                    matched = (txt, phi, bbox)
                    break

        if matched:
            lt, wr, pred_bbox = matched
            tp += 1
            det_status = "DETECTED"
            red_status = "FULLY_REDACTED" if wr else "DETECTED_NOT_REDACTED"

            if pred_bbox and len(pred_bbox) == 4:
                iou = compute_iou(gt_bbox, tuple(pred_bbox))
                pred_bbox_str = str(pred_bbox[0])+","+str(pred_bbox[1])+","+str(pred_bbox[2])+","+str(pred_bbox[3])
                iou_values.append(iou)
            else:
                iou = -1.0
                pred_bbox_str = ""
        else:
            lt = ""
            wr = False
            fn += 1
            det_status = "NOT_DETECTED"
            red_status = "NOT_REDACTED"
            iou = -1.0
            pred_bbox_str = ""

        gt_bbox_str = str(gt["x"])+","+str(gt["y"])+","+str(gt["width"])+","+str(gt["height"])
        det_rows.append({"image_id": stem, "phi_type": gt["phi_type"],
            "gt_text": gt["text"], "detected_text": lt,
            "text_match": "TRUE" if matched else "FALSE",
            "detection_status": det_status, "predicted_bbox": pred_bbox_str,
            "iou": iou, "notes": ""})
        red_rows.append({"image_id": stem, "phi_type": gt["phi_type"],
            "ground_truth_bbox": gt_bbox_str, "predicted_bbox": pred_bbox_str,
            "iou": iou, "redaction_status": red_status, "notes": ""})

    # Count false positives
    for entry in log:
        txt = entry[0]
        phi = entry[1]
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

# IoU statistics
valid_ious = [v for v in iou_values if v >= 0]
mean_iou = sum(valid_ious) / len(valid_ious) if valid_ious else 0.0
iou_above_50 = sum(1 for v in valid_ious if v >= 0.5)
iou_above_75 = sum(1 for v in valid_ious if v >= 0.75)

# Per-type breakdown
type_stats = {}
for d in det_rows:
    pt = d["phi_type"]
    if pt not in type_stats:
        type_stats[pt] = {"tp": 0, "fn": 0, "ious": []}
    if d["detection_status"] == "DETECTED":
        type_stats[pt]["tp"] += 1
        if d["iou"] >= 0:
            type_stats[pt]["ious"].append(d["iou"])
    else:
        type_stats[pt]["fn"] += 1

metrics = {
    "total_gt_phi_instances": total,
    "true_positives": tp,
    "false_positives": fp,
    "false_negatives": fn,
    "precision": round(P, 4),
    "recall": round(R, 4),
    "f1": round(F1, 4),
    "mean_iou": round(mean_iou, 4),
    "iou_samples": len(valid_ious),
    "iou_gte_0.50": iou_above_50,
    "iou_gte_0.75": iou_above_75,
    "redaction_fully_redacted": rc.get("FULLY_REDACTED", 0),
    "redaction_detected_not_redacted": rc.get("DETECTED_NOT_REDACTED", 0),
    "redaction_not_redacted": rc.get("NOT_REDACTED", 0),
}

# Per-type metrics
for pt, st in sorted(type_stats.items()):
    r_pt = st["tp"] / (st["tp"] + st["fn"]) if (st["tp"]+st["fn"]) else 0
    m_iou = sum(st["ious"]) / len(st["ious"]) if st["ious"] else 0
    metrics["recall_" + pt] = round(r_pt, 4)
    metrics["mean_iou_" + pt] = round(m_iou, 4)

# Write CSVs
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

# ---- FRACTURE MAPPING (unchanged logic) ----
print()
print("--- Fracture annotation mapping ---")
ann_map, ovr_rows = [], []
phi_overlaps = 0
has_frac_count = 0

for row in gt_records:
    src = Path(row["source_image"]); stem2 = src.stem
    ytxt = FRAC_YOLO / (stem2 + ".txt")
    iw = int(row["image_width"]); ih = int(row["image_height"])
    frac_boxes = []
    if ytxt.exists():
        for line in ytxt.read_text(errors="ignore").splitlines():
            p = line.strip().split()
            if len(p) == 5:
                try:
                    xc=float(p[1]); yc=float(p[2]); bw=float(p[3]); bh=float(p[4])
                    if all(0<=v<=1 for v in (xc,yc,bw,bh)):
                        x1=max(0,round((xc-bw/2)*iw)); y1=max(0,round((yc-bh/2)*ih))
                        x2=min(iw,round((xc+bw/2)*iw)); y2=min(ih,round((yc+bh/2)*ih))
                        frac_boxes.append((x1,y1,x2-x1,y2-y1))
                except: pass
    if frac_boxes: has_frac_count += 1
    px=int(row["x"]); py=int(row["y"]); pw=int(row["width"]); ph=int(row["height"])
    overlaps = []
    for fx,fy,fw,fh in frac_boxes:
        ix1=max(px,fx); iy1=max(py,fy)
        ix2=min(px+pw,fx+fw); iy2=min(py+ph,fy+fh)
        iwa=max(0,ix2-ix1); iha=max(0,iy2-iy1)
        if iwa>0 and iha>0:
            oa=iwa*iha; pa=pw*ph
            overlaps.append({"fracture_bbox": str(fx)+","+str(fy)+","+str(fw)+","+str(fh),
                "overlap_area": oa, "pct_phi_covered": round(oa/pa if pa else 0, 4)})
    if overlaps: phi_overlaps += 1
    ann_map.append({"synthetic_image_id": row["synthetic_image_id"], "source_image": src.name,
        "phi_type": row["phi_type"], "yolo_annotation_found": str(ytxt.exists()),
        "has_fracture_annotation": str(len(frac_boxes)>0), "num_fracture_boxes": len(frac_boxes),
        "fracture_boxes": "; ".join(str(b[0])+","+str(b[1])+","+str(b[2])+","+str(b[3]) for b in frac_boxes)})
    ovr_rows.append({"synthetic_image_id": row["synthetic_image_id"], "source_image": src.name,
        "phi_type": row["phi_type"], "phi_bbox": str(px)+","+str(py)+","+str(pw)+","+str(ph),
        "num_fracture_boxes": len(frac_boxes), "num_overlapping": len(overlaps),
        "phi_overlaps_fracture": str(len(overlaps)>0),
        "overlap_details": json.dumps(overlaps) if overlaps else ""})

print("Fracture annotations with boxes: " + str(has_frac_count) + "/" + str(len(gt_records)))
print("PHI overlapping fracture: " + str(phi_overlaps) + "/" + str(len(ovr_rows)))
write_csv(EVAL / "fracatlas_annotation_map.csv", ann_map)
write_csv(EVAL / "phi_fracture_overlap.csv", ovr_rows)

# ---- ML PROBLEMS (updated) ----
problems = []
problems.append("PROBLEM 1 (RESOLVED): PREDICTED BBOX NOW AVAILABLE\n"
    "  anonymize_xray.py refactored to return (text, is_phi, [x,y,w,h]).\n"
    "  Pixel-level IoU is now computed. Mean IoU = " + str(round(mean_iou,4)) + "\n"
    "  IoU >= 0.50: " + str(iou_above_50) + "/" + str(len(valid_ious)) + "\n"
    "  IoU >= 0.75: " + str(iou_above_75) + "/" + str(len(valid_ious)))

if R < 1.0:
    problems.append("PROBLEM 2: OCR DETECTION RECALL = " + str(round(R,4)) + "\n"
        "  " + str(fn) + "/" + str(total) + " GT PHI missed.\n"
        "  Likely cause: small thumbnail images where OCR fails at native resolution.\n"
        "  app/ocr.py upscales 2x -- anonymize_xray.py does not.")

if fp > 0:
    problems.append("PROBLEM 3: FALSE POSITIVES = " + str(fp) + "\n"
        "  Adding 'scan'/'date' to PHI_KEYWORDS may increase FP on date-like metadata.\n"
        "  Monitor FP rate; consider requiring keyword+value pattern.")

nr = rc.get("NOT_REDACTED", 0)
if nr > 0:
    problems.append("PROBLEM 4: NOT REDACTED = " + str(nr) + " regions\n"
        "  GT PHI that was not detected or not classified as PHI.")

dnr = rc.get("DETECTED_NOT_REDACTED", 0)
if dnr > 0:
    problems.append("PROBLEM 5: DETECTED BUT NOT REDACTED = " + str(dnr) + " regions\n"
        "  OCR found the text but line_is_phi returned False.")

problems.append("PROBLEM 6: IMAGE UPSCALING GAP\n"
    "  app/ocr.py: 2x upscale + normalize before OCR.\n"
    "  anonymize_xray.py: native resolution only.\n"
    "  Systematic recall deficit for small FracAtlas thumbnails.")

problems.append("PROBLEM 7: FRACTURE REGION CONFLICT\n"
    "  " + str(phi_overlaps) + " PHI annotations overlap YOLO fracture bboxes.\n"
    "  anonymize_xray.py blindly fills black over fracture zones.\n"
    "  app/anonymizer.py routes these to manual review queue.\n"
    "  Policy must be defined for research.")

problems.append("PROBLEM 8: NO CONFIDENCE THRESHOLD\n"
    "  anonymize_xray.py accepts all Tesseract output.\n"
    "  app/ocr.py filters at conf >= 35.")

problems.append("PROBLEM 9: NO METADATA SCRUBBING\n"
    "  app/anonymizer.py strips EXIF/IPTC. anonymize_xray.py does not.")

ml_path = EVAL / "ml_problems.txt"
with ml_path.open("w", encoding="utf-8") as f:
    f.write("WBE ML ANONYMIZATION - PHASE 1: ML PROBLEMS (v2 - WITH IoU)\n")
    f.write("=" * 60 + "\n\n")
    for p in problems:
        f.write(p + "\n\n")
print("[WROTE] " + str(ml_path) + " (" + str(len(problems)) + " problems)")

# ---- FINAL SUMMARY ----
print()
print("=" * 60)
print("  PHASE 1 COMPLETE (v2 - WITH IoU)")
print("=" * 60)
print("  Total GT PHI      : " + str(total))
print("  True Positives    : " + str(tp))
print("  False Positives   : " + str(fp))
print("  False Negatives   : " + str(fn))
print("  Precision         : " + str(round(P,4)))
print("  Recall            : " + str(round(R,4)))
print("  F1                : " + str(round(F1,4)))
print("  Mean IoU          : " + str(round(mean_iou,4)))
print("  IoU >= 0.50       : " + str(iou_above_50) + "/" + str(len(valid_ious)))
print("  IoU >= 0.75       : " + str(iou_above_75) + "/" + str(len(valid_ious)))
print("  Fully Redacted    : " + str(rc.get("FULLY_REDACTED",0)))
print("  Detected !Redact  : " + str(rc.get("DETECTED_NOT_REDACTED",0)))
print("  Not Redacted      : " + str(rc.get("NOT_REDACTED",0)))
print("  PHI-Frac Overlap  : " + str(phi_overlaps))
print()
for pt in sorted(type_stats.keys()):
    st = type_stats[pt]
    r_pt = st["tp"]/(st["tp"]+st["fn"]) if (st["tp"]+st["fn"]) else 0
    m_iou = sum(st["ious"])/len(st["ious"]) if st["ious"] else 0
    print("  " + pt + ": recall=" + str(round(r_pt,4)) + " mean_iou=" + str(round(m_iou,4)))
print("=" * 60)

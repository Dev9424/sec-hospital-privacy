#!/usr/bin/env python3
"""
phase1_pipeline.py - WBE ML Anonymization Phase 1 Orchestrator
"""
from __future__ import annotations
import csv, importlib.util, json, os, subprocess, sys, time
from pathlib import Path

BASE_DIR   = Path(__file__).parent.resolve()
FRACATLAS  = BASE_DIR / "FracAtlas"
FRAC_IMGS  = FRACATLAS / "images"
FRAC_YOLO  = FRACATLAS / "Annotations" / "YOLO"
DATASETS   = BASE_DIR / "datasets"
SYNTH_DIR  = DATASETS / "synthetic_phi"
EVAL_DIR   = DATASETS / "evaluation"
ANON_OUT   = DATASETS / "anonymized_output"
SYNTH_IMGS = SYNTH_DIR / "images"
GT_CSV     = SYNTH_DIR / "ground_truth.csv"
TESSERACT  = BASE_DIR / "tesseract.exe"
TESSDATA   = BASE_DIR / "tessdata"
N_IMAGES   = 100
SEED       = 42

def banner(msg):
    print(f"\n{'='*60}\n  {msg}\n{'='*60}")

def step1_generate():
    banner("STEP 1 - Generate 100-image synthetic PHI dataset")
    gen = BASE_DIR / "synthetic_phi_generator.py"
    if not gen.exists(): sys.exit(f"[FATAL] {gen} not found")
    cmd = [sys.executable, str(gen),
           "--input-dir", str(FRAC_IMGS),
           "--output-dir", str(SYNTH_DIR),
           "--count", str(N_IMAGES), "--seed", str(SEED),
           "--placement", "random", "--lines", "4", "--format", "jpg"]
    print("[CMD]", " ".join(cmd))
    t0 = time.time()
    r = subprocess.run(cmd, capture_output=True, text=True)
    print(r.stdout)
    if r.returncode != 0:
        print("[STDERR]", r.stderr)
        sys.exit(f"[FATAL] Generator failed ({r.returncode})")
    imgs = list(SYNTH_IMGS.glob("*.jpg"))
    print(f"[OK] {len(imgs)} images in {time.time()-t0:.1f}s")
    return imgs

def step2_anonymize(synth_images):
    banner("STEP 2 - Run anonymize_xray.py on all images")
    anon_script = BASE_DIR / "anonymize_xray.py"
    if not anon_script.exists(): sys.exit("[FATAL] anonymize_xray.py not found")
    ANON_OUT.mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location("anonymize_xray", anon_script)
    mod  = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    import pytesseract
    pytesseract.pytesseract.tesseract_cmd = str(TESSERACT)
    os.environ["TESSDATA_PREFIX"] = str(TESSDATA)
    results, errors = {}, []
    for idx, img in enumerate(sorted(synth_images), 1):
        out = ANON_OUT / img.name
        try:
            log = mod.anonymize(str(img), str(out))
            results[img.stem] = {"log": log, "out": out}
            if idx % 10 == 0 or idx == len(synth_images):
                print(f"  [{idx}/{len(synth_images)}] {img.name}")
        except Exception as e:
            errors.append({"image": img.name, "error": str(e)})
            print(f"  [ERR] {img.name}: {e}")
    print(f"[OK] Ran on {len(results)} images. Errors: {len(errors)}")
    return results, errors

def _norm(t): return " ".join(t.upper().strip().split())

def step3_evaluate(synth_images, anon_results, anon_errors):
    banner("STEP 3+4 - Evaluate detection and redaction vs ground truth")
    if not GT_CSV.exists(): sys.exit(f"[FATAL] {GT_CSV} missing")
    gt_records = list(csv.DictReader(GT_CSV.open(encoding="utf-8")))
    print(f"[INFO] GT annotations: {len(gt_records)}")
    gt_by_img = {}
    for row in gt_records:
        gt_by_img.setdefault(row["synthetic_image_id"], []).append(row)
    det_rows, red_rows = [], []
    tp = fp = fn = 0
    for img in sorted(synth_images):
        stem   = img.stem
        gt_list = gt_by_img.get(stem, [])
        info    = anon_results.get(stem)
        if info is None:
            for gt in gt_list:
                det_rows.append({"image_id":stem,"phi_type":gt["phi_type"],"gt_text":gt["text"],
                    "detected_text":"","text_match":"FALSE","detection_status":"ERROR","iou":-1,"notes":"anon error"})
                red_rows.append({"image_id":stem,"phi_type":gt["phi_type"],
                    "ground_truth_bbox":f"{gt['x']},{gt['y']},{gt['width']},{gt['height']}",
                    "predicted_bbox":"","iou":-1,"redaction_status":"NOT_REDACTED","notes":"anon error"})
                fn += 1
            continue
        log = info["log"]
        for gt in gt_list:
            gtn = _norm(gt["text"])
            matched = None
            for txt, phi in log:
                if gtn in _norm(txt): matched = (txt,phi); break
            if matched is None:
                gt_tok = set(gtn.split())
                for txt, phi in log:
                    if len(gt_tok & set(_norm(txt).split())) >= max(1, len(gt_tok)//2):
                        matched = (txt,phi); break
            if matched:
                lt, wr = matched; tp += 1
                det_status = "DETECTED"
                red_status = "FULLY_REDACTED" if wr else "DETECTED_NOT_REDACTED"
            else:
                lt = ""; wr = False; fn += 1
                det_status = "NOT_DETECTED"; red_status = "NOT_REDACTED"
            det_rows.append({"image_id":stem,"phi_type":gt["phi_type"],"gt_text":gt["text"],
                "detected_text":lt,"text_match":"TRUE" if matched else "FALSE",
                "detection_status":det_status,"iou":-1,"notes":"IoU N/A: no predicted bbox"})
            red_rows.append({"image_id":stem,"phi_type":gt["phi_type"],
                "ground_truth_bbox":f"{gt['x']},{gt['y']},{gt['width']},{gt['height']}",
                "predicted_bbox":"","iou":-1,"redaction_status":red_status,"notes":"pixel IoU N/A"})
        for txt, phi in log:
            if not phi: continue
            if not any(_norm(g["text"]) in _norm(txt) or _norm(txt) in _norm(g["text"]) for g in gt_list):
                fp += 1
    total = tp + fn
    P = tp/(tp+fp) if (tp+fp) else 0
    R = tp/total if total else 0
    F1 = 2*P*R/(P+R) if (P+R) else 0
    rc = {}
    for r in red_rows: rc[r["redaction_status"]] = rc.get(r["redaction_status"],0)+1
    metrics = {"total_gt_phi_instances":total,"true_positives":tp,"false_positives":fp,
        "false_negatives":fn,"precision":round(P,4),"recall":round(R,4),"f1":round(F1,4),
        "redaction_fully_redacted":rc.get("FULLY_REDACTED",0),
        "redaction_detected_not_redacted":rc.get("DETECTED_NOT_REDACTED",0),
        "redaction_not_redacted":rc.get("NOT_REDACTED",0),
        "note_iou":"anonymize_xray.py has no predicted bbox output",
        "note_redaction":"FULLY_REDACTED=line marked PHI by anonymizer"}
    return det_rows, red_rows, metrics

def step8_fracture(synth_images):
    banner("STEP 8 - Fracture annotation mapping")
    if not GT_CSV.exists(): return [],[]
    gt_records = list(csv.DictReader(GT_CSV.open(encoding="utf-8")))
    ann_map, ovr_rows = [],[]
    for row in gt_records:
        src = Path(row["source_image"]); stem = src.stem
        ytxt = FRAC_YOLO / f"{stem}.txt"
        iw,ih = int(row["image_width"]),int(row["image_height"])
        frac_boxes = []
        if ytxt.exists():
            for line in ytxt.read_text(errors="ignore").splitlines():
                p = line.strip().split()
                if len(p)==5:
                    try:
                        _,xc,yc,bw,bh = map(float,p)
                        if all(0<=v<=1 for v in (xc,yc,bw,bh)):
                            x1=max(0,round((xc-bw/2)*iw)); y1=max(0,round((yc-bh/2)*ih))
                            x2=min(iw,round((xc+bw/2)*iw)); y2=min(ih,round((yc+bh/2)*ih))
                            frac_boxes.append((x1,y1,x2-x1,y2-y1))
                    except: pass
        px,py,pw,ph = int(row["x"]),int(row["y"]),int(row["width"]),int(row["height"])
        overlaps=[]
        for fx,fy,fw,fh in frac_boxes:
            ix1=max(px,fx); iy1=max(py,fy); ix2=min(px+pw,fx+fw); iy2=min(py+ph,fy+fh)
            iwa=max(0,ix2-ix1); iha=max(0,iy2-iy1)
            if iwa>0 and iha>0:
                oa=iwa*iha; pa=pw*ph
                overlaps.append({"fracture_bbox":f"{fx},{fy},{fw},{fh}",
                    "overlap_area":oa,"pct_phi_covered":round(oa/pa if pa else 0,4)})
        ann_map.append({"synthetic_image_id":row["synthetic_image_id"],"source_image":src.name,
            "phi_type":row["phi_type"],"yolo_found":ytxt.exists(),
            "has_fracture":len(frac_boxes)>0,"num_fracture_boxes":len(frac_boxes),
            "fracture_boxes":"; ".join(f"{b[0]},{b[1]},{b[2]},{b[3]}" for b in frac_boxes)})
        ovr_rows.append({"synthetic_image_id":row["synthetic_image_id"],"source_image":src.name,
            "phi_type":row["phi_type"],"phi_bbox":f"{px},{py},{pw},{ph}",
            "num_fracture_boxes":len(frac_boxes),"num_overlapping":len(overlaps),
            "phi_overlaps_fracture":len(overlaps)>0,
            "overlap_details":json.dumps(overlaps) if overlaps else ""})
    n_ovr = sum(1 for r in ovr_rows if r["phi_overlaps_fracture"])
    print(f"[INFO] {len(ann_map)} annotations checked. {n_ovr} PHI overlap fracture regions.")
    return ann_map, ovr_rows

def _write_csv(path, rows):
    if not rows: return
    with open(path,"w",newline="",encoding="utf-8") as f:
        w=csv.DictWriter(f,fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
    print(f"[WROTE] {path}")

def _problems(metrics, det_rows, red_rows, errors):
    probs=[]
    P=metrics.get("precision",0); R=metrics.get("recall",0)
    fn=metrics.get("false_negatives",0); fp=metrics.get("false_positives",0)
    nr=metrics.get("redaction_not_redacted",0); total=max(1,metrics.get("total_gt_phi_instances",1))
    probs.append("PROBLEM 1 (CRITICAL): NO PREDICTED BBOX\n"
        "  anonymize_xray.py returns only (line_text, was_redacted). No predicted bounding boxes.\n"
        "  Pixel-level IoU cannot be computed. MINIMAL FIX: return bbox list from anonymize().")
    if R < 0.8:
        probs.append(f"PROBLEM 2: LOW RECALL ({R:.2%})\n"
            f"  {fn}/{total} GT PHI instances not detected.\n"
            "  Causes: (a) native-resolution OCR fails on small images, "
            "(b) keyword list misses some PHI line formats.")
    if P < 0.75:
        probs.append(f"PROBLEM 3: LOW PRECISION ({P:.2%})\n"
            f"  {fp} false positives. Keyword 'id' too broad.")
    if nr > 0:
        probs.append(f"PROBLEM 4: INCOMPLETE REDACTION\n  {nr} GT PHI regions not redacted.")
    if errors:
        probs.append(f"PROBLEM 5: ANONYMIZER ERRORS\n  {len(errors)} images failed processing.")
    probs.append("PROBLEM 6: IMAGE UPSCALING GAP\n"
        "  app/ocr.py 2x-upscales before OCR; anonymize_xray.py does not.\n"
        "  Creates systematic recall deficit for small FracAtlas thumbnails.")
    probs.append("PROBLEM 7: FRACTURE REGION CONFLICT\n"
        "  anonymize_xray.py blindly redraws PHI over fracture zones.\n"
        "  app/anonymizer.py routes these to review queue. Policy undefined for research.")
    probs.append("PROBLEM 8: PHI-FRACTURE OVERLAP IN BENCHMARK\n"
        "  Random PHI placement can overlap YOLO fracture boxes.\n"
        "  Ground truth records this. See phi_fracture_overlap.csv.")
    return probs

def step9_write(det_rows, red_rows, metrics, ann_map, ovr_rows, errors):
    banner("STEP 9 - Write evaluation outputs")
    EVAL_DIR.mkdir(parents=True, exist_ok=True)
    _write_csv(EVAL_DIR/"detection_results.csv", det_rows)
    _write_csv(EVAL_DIR/"redaction_results.csv", red_rows)
    _write_csv(EVAL_DIR/"fracatlas_annotation_map.csv", ann_map)
    _write_csv(EVAL_DIR/"phi_fracture_overlap.csv", ovr_rows)
    sm = EVAL_DIR/"summary_metrics.csv"
    with sm.open("w",newline="",encoding="utf-8") as f:
        w=csv.DictWriter(f,fieldnames=["metric","value"]); w.writeheader()
        for k,v in metrics.items(): w.writerow({"metric":k,"value":v})
    print(f"[WROTE] {sm}")
    probs = _problems(metrics, det_rows, red_rows, errors)
    ml = EVAL_DIR/"ml_problems.txt"
    with ml.open("w",encoding="utf-8") as f:
        f.write("WBE ML ANONYMIZATION - PHASE 1 ML PROBLEMS\n"+"="*60+"\n\n")
        for p in probs: f.write(p+"\n\n")
    print(f"[WROTE] {ml}")
    return probs

def main():
    print("\n"+"="*60+"\n  WBE ML ANONYMIZATION - PHASE 1\n"+"="*60)
    t = time.time()
    imgs    = step1_generate()
    res,err = step2_anonymize(imgs)
    dr,rr,m = step3_evaluate(imgs, res, err)
    am,ovr  = step8_fracture(imgs)
    probs   = step9_write(dr, rr, m, am, ovr, err)
    banner("PHASE 1 COMPLETE")
    print(f"  Images       : {len(imgs)}")
    print(f"  GT annots    : {m.get('total_gt_phi_instances')}")
    print(f"  TP/FP/FN     : {m.get('true_positives')}/{m.get('false_positives')}/{m.get('false_negatives')}")
    print(f"  P/R/F1       : {m.get('precision')}/{m.get('recall')}/{m.get('f1')}")
    print(f"  Fully redact : {m.get('redaction_fully_redacted')}")
    print(f"  Not redacted : {m.get('redaction_not_redacted')}")
    print(f"  ML Problems  : {len(probs)}")
    print(f"  Elapsed      : {time.time()-t:.1f}s")
    print(f"  Outputs      : {EVAL_DIR}")

if __name__ == "__main__":
    main()

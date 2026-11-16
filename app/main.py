from pathlib import Path
import os, sys, cv2, numpy as np, base64, random, time
from fastapi import FastAPI,File,Form,HTTPException,UploadFile
from pydantic import BaseModel
from .anonymizer import scrub_metadata,anonymize,encode_jpeg,new_filename
from .fracatlas import load_yolo_boxes
from .ocr import detect_text

# Step 5: import text_anonymization from project root (one level above app/).
# text_anonymization.py logic is NOT modified here — we only import it.
_PROJECT_ROOT = str(Path(__file__).parent.parent)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)
from text_anonymization import anonymize_clinical_note

app=FastAPI(title="SUPMS Medical Data Anonymization Service",version="0.1.0")
MAX_BYTES=int(os.getenv("MAX_IMAGE_BYTES",20*1024*1024))
ALLOWED={"image/jpeg","image/png","image/webp"}

# ── Synthetic PHI data pools (no real PII) ──────────────────────────────────
_FIRST = ["AARAV","RIA","KABIR","PRIYA","ARJUN","MEERA","VIVEK","SNEHA","ROHAN",
          "ANJALI","NIKHIL","DIVYA","AMIT","POOJA","RAHUL","NEHA","SURESH","KAVITA"]
_LAST  = ["MEHTA","SHARMA","VERMA","KUMAR","SINGH","PATEL","GUPTA","JOSHI","NAIR",
          "REDDY","IYER","PILLAI","RAO","BHAT","MENON","KRISHNAN","AGARWAL","BANSAL"]
_DEPTS = ["RADIOLOGY","ORTHOPAEDICS","EMERGENCY MEDICINE","TRAUMA & ORTHO",
          "DIAGNOSTIC IMAGING","INTERVENTIONAL RADIOLOGY","MUSCULOSKELETAL IMAGING"]
_DOCTORS = ["DR. R. SHARMA","DR. A. MEHTA","DR. S. PATEL","DR. K. NAIR",
            "DR. V. REDDY","DR. P. GUPTA","DR. M. JOSHI","DR. N. IYER"]

def _synthetic_phi():
    rng = random.Random()
    name  = f"{rng.choice(_FIRST)} {rng.choice(_LAST)}"
    pid   = f"SUPMS-P{rng.randint(10000,99999)}"
    d,m,y = rng.randint(1,28), rng.randint(1,12), rng.randint(1950,2005)
    dob   = f"{d:02d}/{m:02d}/{y}"
    doc   = rng.choice(_DOCTORS)
    dept  = rng.choice(_DEPTS)
    return [
        {"type":"PATIENT_NAME",  "label":f"PATIENT: {name}"},
        {"type":"PATIENT_ID",    "label":f"PATIENT ID: {pid}"},
        {"type":"DOB",           "label":f"DOB: {dob}"},
        {"type":"DOCTOR_NAME",   "label":f"REF: {doc}"},
        {"type":"DEPARTMENT",    "label":f"DEPT: {dept}"},
    ]

def _render_phi_on_image(img_bgr, fields):
    """Render synthetic PHI text onto an image copy. Returns (annotated_img, ground_truth_list)."""
    from PIL import Image as PILImage, ImageDraw, ImageFont
    import io

    img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
    pil_img = PILImage.fromarray(img_rgb)
    draw    = ImageDraw.Draw(pil_img)
    iw, ih  = pil_img.size

    font_size = max(12, min(iw, ih) // 28)
    font_candidates = [
        "C:/Windows/Fonts/courbd.ttf",
        "C:/Windows/Fonts/cour.ttf",
        "C:/Windows/Fonts/lucon.ttf",
        "C:/Windows/Fonts/consola.ttf",
        "C:/Windows/Fonts/arial.ttf",
    ]
    font = None
    for fc in font_candidates:
        if Path(fc).exists():
            try:
                from PIL import ImageFont
                font = ImageFont.truetype(fc, font_size)
                break
            except Exception:
                continue
    if font is None:
        from PIL import ImageFont
        font = ImageFont.load_default()

    margin   = max(8, min(iw, ih) // 40)
    line_h   = font_size + 6
    gray     = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    # Pick the region with lowest brightness (good contrast for white text)
    regions = {
        "bottom_right": (max(0,iw//2), max(0,ih//2), iw, ih),
        "top_left":     (0, 0, iw//2, ih//2),
        "bottom_left":  (0, max(0,ih//2), iw//2, ih),
    }
    best_region, best_bright = "bottom_right", float("inf")
    for rname,(x1,y1,x2,y2) in regions.items():
        roi = gray[y1:y2, x1:x2]
        if roi.size > 0:
            b = float(np.mean(roi))
            if b < best_bright:
                best_bright = b; best_region = rname

    rx1,ry1,rx2,ry2 = regions[best_region]
    start_x = rx1 + margin
    start_y = ry1 + margin

    text_color = (255,255,255) if best_bright < 128 else (20,20,20)
    gt = []
    cy = start_y
    for f in fields:
        lbl = f["label"]
        try:
            bbox_obj = font.getbbox(lbl)
            tw = bbox_obj[2] - bbox_obj[0]
            th = bbox_obj[3] - bbox_obj[1]
        except Exception:
            tw = len(lbl) * (font_size // 2); th = font_size
        x1b = start_x; y1b = cy
        x2b = min(iw, x1b + tw + 6); y2b = min(ih, y1b + th + 4)
        draw.text((x1b, y1b), lbl, fill=text_color, font=font)
        gt.append({"type": f["type"], "text": lbl, "bbox": [x1b, y1b, x2b, y2b]})
        cy += line_h

    result_rgb = np.array(pil_img)
    result_bgr = cv2.cvtColor(result_rgb, cv2.COLOR_RGB2BGR)
    return result_bgr, gt

@app.get("/health")
def health(): return {"status":"ok","service":"supms-anonymization"}


# ── Step 5: Text anonymization endpoint ────────────────────────────────────
class TextAnonymizeRequest(BaseModel):
    text: str
    base_noise: float = 300.0
    largest_group_size: int = 1000
    current_group_size: int = 1000

class TextAnonymizeResponse(BaseModel):
    anonymized_text: str
    original_length: int
    anonymized_length: int

@app.post("/anonymize-text", response_model=TextAnonymizeResponse)
def anonymize_text(req: TextAnonymizeRequest):
    """
    Anonymize a clinical text note.
    Wraps text_anonymization.anonymize_clinical_note() without modifying its logic.
    Pipeline: regex redaction -> spaCy NER redaction -> Fair-DP noise on numeric lab values.
    """
    if not req.text or not req.text.strip():
        raise HTTPException(status_code=400, detail="text field must not be empty")
    result = anonymize_clinical_note(
        req.text,
        base_noise=req.base_noise,
        largest_group_size=req.largest_group_size,
        current_group_size=req.current_group_size,
    )
    return TextAnonymizeResponse(
        anonymized_text=result,
        original_length=len(req.text),
        anonymized_length=len(result),
    )


@app.post("/anonymize")
async def run(file:UploadFile=File(...),annotation_root:str|None=Form(None),
              annotation_filename:str|None=Form(None)):
    if file.content_type not in ALLOWED: raise HTTPException(415,"Unsupported image type")
    raw=await file.read()
    if not raw or len(raw)>MAX_BYTES: raise HTTPException(413,"Image missing or too large")
    
    # Pre-process: Strip metadata (Problem 9 fixed automatically here)
    image=cv2.imdecode(np.frombuffer(scrub_metadata(raw),np.uint8),cv2.IMREAD_COLOR)
    if image is None: raise HTTPException(400,"Invalid image")
    
    # Load fracture boxes if provided
    ann=None
    if annotation_root and annotation_filename:
        root=Path(annotation_root).resolve()
        candidate=(root/annotation_filename).resolve()
        try: candidate.relative_to(root)
        except ValueError: raise HTTPException(400,"Invalid annotation path")
        ann=str(candidate)
        
    from .fracture_aware_anonymizer import anonymize_xray, read_yolo_annotation_file
    
    # Convert YOLO .txt file to list of tuples if it exists
    yolo_boxes = None
    if ann and Path(ann).exists():
        yolo_boxes = read_yolo_annotation_file(ann)
        
    # Run the new all-in-one ML pipeline
    output, log = anonymize_xray(image, fracture_boxes_yolo=yolo_boxes)
    
    import base64
    outdir=Path(os.getenv("ANON_OUTPUT_DIR","./anonymized_output")); outdir.mkdir(parents=True,exist_ok=True)
    name=new_filename()
    encoded_img = encode_jpeg(output)
    (outdir/name).write_bytes(encoded_img)
    
    return {
        "status": "manual_review_required" if log["review_lines_detected"] > 0 else "success",
        "output_file": name,
        "image_base64": base64.b64encode(encoded_img).decode('utf-8'),
        "image": {"width": image.shape[1], "height": image.shape[0]},
        "ocr_words_detected": log["ocr_words_detected"],
        "phi_lines_detected": log["phi_lines_detected"],
        "review_lines_detected": log["review_lines_detected"],
        "redacted_solid": log["redacted_solid"],
        "redacted_pixelated": log["redacted_pixelated"],
        "fracture_boxes": log["fracture_boxes"],
        "phi_lines": log["lines"],
        "review_lines": log.get("review_lines", []),
        "metadata_scrubbed": True
    }

# ── NEW: 3-Panel demo pipeline ──────────────────────────────────────────────
DATASET_ORIGINAL = Path(__file__).parent.parent / "datasets" / "synthetic_benchmark" / "original"

@app.get("/demo/dataset-images")
def list_dataset_images():
    """Return a list of available X-ray images from the benchmark dataset."""
    if not DATASET_ORIGINAL.exists():
        return {"images": []}
    images = sorted([p.name for p in DATASET_ORIGINAL.glob("*.jpg")])
    return {"images": images, "count": len(images)}

@app.post("/demo-pipeline")
async def demo_pipeline(
    file: UploadFile = File(None),
    dataset_image: str = Form(None)
):
    """
    Full 3-panel demo: original → synthetic-PHI contamination → anonymization.
    Accepts either:
    - An uploaded image file (file=)
    - A filename from the benchmark dataset (dataset_image=)
    Returns: original_b64, contaminated_b64, anonymized_b64, syntheticPHI, detections, metrics.
    """
    from .fracture_aware_anonymizer import anonymize_xray

    t_start = time.time()

    # ── Load the original image ──
    if file is not None and file.filename:
        raw = await file.read()
        if not raw or len(raw) > MAX_BYTES:
            raise HTTPException(413, "Image missing or too large")
        image_orig = cv2.imdecode(np.frombuffer(scrub_metadata(raw), np.uint8), cv2.IMREAD_COLOR)
    elif dataset_image:
        # Sanitize: only allow plain filenames, no path traversal
        safe_name = Path(dataset_image).name
        img_path = DATASET_ORIGINAL / safe_name
        if not img_path.exists() or not img_path.is_file():
            raise HTTPException(404, f"Dataset image not found: {safe_name}")
        image_orig = cv2.imread(str(img_path))
    else:
        raise HTTPException(400, "Provide either a file upload or dataset_image name")

    if image_orig is None:
        raise HTTPException(400, "Invalid or unreadable image")

    # ── STEP 1: Encode original ──
    orig_bytes  = encode_jpeg(image_orig)
    orig_b64    = base64.b64encode(orig_bytes).decode()

    # ── STEP 2: Inject synthetic PHI ──
    phi_fields   = _synthetic_phi()
    contam_img, ground_truth = _render_phi_on_image(image_orig.copy(), phi_fields)
    contam_bytes = encode_jpeg(contam_img)
    contam_b64   = base64.b64encode(contam_bytes).decode()

    # ── STEP 3: Run the existing anonymization pipeline on contaminated image ──
    anon_img, log = anonymize_xray(contam_img)
    anon_bytes   = encode_jpeg(anon_img)
    anon_b64     = base64.b64encode(anon_bytes).decode()

    elapsed_ms = round((time.time() - t_start) * 1000)

    # ── Compute detection metrics against ground truth ──
    total_phi      = len(ground_truth)
    detected_lines = [l for l in log["lines"] if l.get("phi")]
    detected_phi   = 0
    detections     = []

    def _iou(a, b):
        ix1,iy1 = max(a[0],b[0]),max(a[1],b[1])
        ix2,iy2 = min(a[2],b[2]),min(a[3],b[3])
        inter   = max(0,ix2-ix1)*max(0,iy2-iy1)
        if inter == 0: return 0.0
        aa = (a[2]-a[0])*(a[3]-a[1]); ab = (b[2]-b[0])*(b[3]-b[1])
        return inter/(aa+ab-inter+1e-6)

    matched_gt = set()
    for dl in detected_lines:
        db = dl.get("box")
        if not db: continue
        detections.append({"bbox": db, "text": dl.get("text",""), "action": dl.get("action","")})
        for gi, gt_f in enumerate(ground_truth):
            if gi in matched_gt: continue
            if _iou(db, gt_f["bbox"]) >= 0.25:
                detected_phi += 1
                matched_gt.add(gi)
                break

    # Bug 1 fix: anonymizedPHI must count injected GT fields whose box is
    # covered by a redaction, not all redacted lines (which include real text
    # already on the image).  We iterate redacted lines (action=="redacted" or
    # "pixelated") and check each against unmatched GT boxes.
    redacted_lines = [l for l in log["lines"] if l.get("action") in ("redacted", "pixelated")]
    anonymized_gt  = set()
    for rl in redacted_lines:
        rb = rl.get("box")
        if not rb: continue
        for gi, gt_f in enumerate(ground_truth):
            if gi in anonymized_gt: continue
            if _iou(rb, gt_f["bbox"]) >= 0.25:
                anonymized_gt.add(gi)
                break
    anonymized_phi = len(anonymized_gt)   # count of injected GT fields actually covered

    detection_rate = round(detected_phi  / total_phi * 100, 1) if total_phi else 0
    anon_rate      = round(anonymized_phi / total_phi * 100, 1) if total_phi else 0

    # Pass source info so the frontend can display which image was processed
    image_source = (file.filename if (file is not None and file.filename)
                    else dataset_image or "unknown")

    return {
        "originalImage":     orig_b64,
        "contaminatedImage": contam_b64,
        "anonymizedImage":   anon_b64,
        "syntheticPHI":      ground_truth,
        "detections":        detections,
        "imageSource":       image_source,
        "metrics": {
            "totalPHI":          total_phi,
            "detectedPHI":       detected_phi,
            "anonymizedPHI":     anonymized_phi,
            "detectionRate":     detection_rate,
            "anonymizationRate": anon_rate,
            "ocrWordsFound":     log["ocr_words_detected"],
            "reviewFlagged":     log["review_lines_detected"],
            "processingTimeMs":  elapsed_ms,
        }
    }

if __name__ == "__main__":
    import argparse, json
    from .anonymizer import anonymize_image
    parser = argparse.ArgumentParser(description="Anonymize a single image")
    parser.add_argument("--input", type=str, required=True, help="Path to the input image")
    args = parser.parse_args()
    
    result = anonymize_image(args.input)
    print(json.dumps(result.model_dump(), indent=2))


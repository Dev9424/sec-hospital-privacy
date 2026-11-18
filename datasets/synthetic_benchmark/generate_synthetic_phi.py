"""
SUPMS-Fair Synthetic PHI Benchmark — Generation Pipeline
=========================================================
Generates a controlled dataset of 100 real FracAtlas X-rays with
synthetically burned-in patient/radiology information for evaluating
the SUPMS anonymization system.

RESEARCH INTEGRITY STATEMENT:
The FracAtlas radiographs are de-identified source images. Synthetic
patient/radiology identifiers are programmatically introduced into
COPIES of the radiographs to create a controlled ground-truth benchmark
for evaluating image de-identification. All patient identifiers are
entirely synthetic and do not correspond to real individuals.

Usage:
    python generate_synthetic_phi.py [--seed 42] [--count 100]
"""

import argparse
import csv
import json
import os
import random
import shutil
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import List, Tuple, Optional, Dict, Any

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

# ─────────────────────────────────────────────────────────────────────────────
# Paths
# ─────────────────────────────────────────────────────────────────────────────
BASE_DIR        = Path(__file__).parent
FRACATLAS_ROOT  = BASE_DIR.parent.parent / "FracAtlas"
FRACTURED_DIR   = FRACATLAS_ROOT / "images" / "Fractured"
NON_FRAC_DIR    = FRACATLAS_ROOT / "images" / "Non_fractured"
YOLO_ANNOT_DIR  = FRACATLAS_ROOT / "Annotations" / "YOLO"

OUTPUT_ROOT     = BASE_DIR
ORIGINAL_DIR    = OUTPUT_ROOT / "original"
CONTAM_DIR      = OUTPUT_ROOT / "contaminated"
GT_DIR          = OUTPUT_ROOT / "ground_truth"
META_DIR        = OUTPUT_ROOT / "metadata"

# Try to find a truetype font for readable radiology text
FONT_CANDIDATES = [
    "C:/Windows/Fonts/courbd.ttf",   # Courier New Bold
    "C:/Windows/Fonts/cour.ttf",     # Courier New
    "C:/Windows/Fonts/lucon.ttf",    # Lucida Console
    "C:/Windows/Fonts/consola.ttf",  # Consolas
    "C:/Windows/Fonts/arial.ttf",    # Arial fallback
]

# ─────────────────────────────────────────────────────────────────────────────
# Synthetic data pools  (deterministic — all generated in-code, no internet)
# ─────────────────────────────────────────────────────────────────────────────
FIRST_NAMES = [
    "AARAV","RIA","KABIR","PRIYA","ARJUN","MEERA","VIVEK","SNEHA",
    "ROHAN","ANJALI","NIKHIL","DIVYA","AMIT","POOJA","RAHUL","NEHA",
    "SURESH","KAVITA","DEEPAK","SUNITA","RAVI","GEETA","MOHAN","LATA",
    "ADITYA","SHALINI","VIJAY","REKHA","SANJAY","USHA","KIRAN","NISHA",
    "AKASH","MANISHA","SACHIN","RASHMI","SHYAM","JYOTI","GANESH","SEEMA",
    "RAJEEV","SWATI","PRAKASH","MADHURI","ASHOK","BINDU","HEMANT","SAROJ",
    "SUBHASH","LALITA","RAMESH","SAVITA","MAHESH","SHANTA","VINOD","LEELA",
    "NARESH","VARSHA","DINESH","SUDHA","HARISH","PUSHPA","KISHORE","KAMAL",
]
LAST_NAMES = [
    "MEHTA","SHARMA","VERMA","KUMAR","SINGH","PATEL","GUPTA","JOSHI",
    "NAIR","REDDY","IYER","PILLAI","RAO","BHAT","MENON","KRISHNAN",
    "AGARWAL","BANSAL","MITTAL","KAPOOR","MALHOTRA","CHOPRA","ARORA","BOSE",
    "CHATTERJEE","MUKHERJEE","DAS","GHOSH","SEN","DUTTA","ROY","MISHRA",
    "SHUKLA","TIWARI","PANDEY","DUBEY","TRIPATHI","SRIVASTAVA","PATHAK",
    "SAXENA","YADAV","MAURYA","CHAUHAN","THAKUR","RAJPUT","RAWAT","RATHI",
]
HOSPITALS = [
    "CITYCARE GENERAL HOSPITAL","APOLLO MEDICAL CENTRE","SUNRISEHEALTH HOSPITAL",
    "NATIONAL MEDICAL INSTITUTE","METRO HEALTHCARE HOSPITAL","LIFELINE HOSPITAL",
    "GREENFIELD MEDICAL CENTRE","UNITY HOSPITAL & RESEARCH","CIVIC HEALTH CENTRE",
    "CENTRAL DISTRICT HOSPITAL","CARE PLUS HOSPITAL","PREMIER DIAGNOSTICS",
    "KRISHNA MEDICAL COLLEGE HOSPITAL","LOTUS MULTISPECIALITY HOSPITAL",
    "RELIABLE HEALTH SERVICES","SARASWATI MEDICAL CENTRE",
]
DEPARTMENTS = [
    "RADIOLOGY","ORTHOPAEDICS","EMERGENCY MEDICINE","TRAUMA & ORTHO",
    "DIAGNOSTIC IMAGING","INTERVENTIONAL RADIOLOGY","MUSCULOSKELETAL IMAGING",
]
DOCTORS = [
    "DR. R. SHARMA","DR. A. MEHTA","DR. S. PATEL","DR. K. NAIR",
    "DR. V. REDDY","DR. P. GUPTA","DR. M. JOSHI","DR. N. IYER",
    "DR. D. BHAT","DR. L. KRISHNAN","DR. C. BANSAL","DR. H. MISHRA",
    "DR. T. VERMA","DR. B. SINGH","DR. Y. YADAV","DR. F. KAPOOR",
]
EXAM_TYPES = [
    "WRIST AP/LAT","HAND AP","ELBOW AP/LAT","FOREARM AP","HUMERUS AP",
    "ANKLE AP/LAT","FOOT AP","KNEE AP/LAT","TIBIA-FIBULA AP","FEMUR AP",
    "SHOULDER AP","HIP AP","SPINE AP/LAT","PELVIS AP","CHEST PA",
    "WRIST LATERAL","HAND OBLIQUE","ANKLE MORTISE","CALCANEUS AX",
]

# PHI field type combinations (varied across images)
PHI_COMBOS = [
    ["PATIENT_NAME","PATIENT_ID","DOB"],
    ["PATIENT_NAME","MRN","HOSPITAL"],
    ["PATIENT_ID","DOB","ACCESSION_NUMBER"],
    ["PATIENT_NAME","HOSPITAL","STUDY_DATE","DOCTOR_NAME"],
    ["PATIENT_NAME","PATIENT_ID","DOB","HOSPITAL","STUDY_DATE"],
    ["MRN","DOB","ACCESSION_NUMBER","DEPARTMENT"],
    ["PATIENT_NAME","DOCTOR_NAME","STUDY_DATE"],
    ["PATIENT_ID","MRN","HOSPITAL","DEPARTMENT"],
    ["PATIENT_NAME","PATIENT_ID","MRN","DOB","ACCESSION_NUMBER"],
    ["HOSPITAL","DEPARTMENT","STUDY_DATE","EXAMINATION_NUMBER"],
    ["PATIENT_NAME","DOB","DOCTOR_NAME","EXAMINATION_NUMBER"],
    ["PATIENT_ID","HOSPITAL","ACCESSION_NUMBER","STUDY_DATE"],
    ["PATIENT_NAME","PATIENT_ID","HOSPITAL","DOCTOR_NAME"],
    ["MRN","STUDY_DATE","DEPARTMENT","EXAMINATION_NUMBER"],
    ["PATIENT_NAME","PATIENT_ID","DOB","DOCTOR_NAME","DEPARTMENT"],
]

# Layout patterns — where the text block starts on the image
# Expressed as (x_fraction, y_fraction) of the image dimensions
LAYOUT_REGIONS = [
    "top_left",
    "top_right",
    "bottom_left",
    "bottom_right",
    "top_center",
]

# ─────────────────────────────────────────────────────────────────────────────
# Data classes
# ─────────────────────────────────────────────────────────────────────────────
@dataclass
class PhiField:
    type: str
    text: str
    bbox: List[int]           # [x1, y1, x2, y2]  pixel coords on image
    placement_region: str
    font_size: int
    text_color: List[int]     # [R, G, B]
    background_treatment: str # "none" | "dark_bg" | "slight_shadow"
    fracture_overlap: bool
    fracture_iou: float
    fracture_annotation_ids: List[int]
    random_seed: int

@dataclass
class ImageAnnotation:
    image_id: str             # e.g. "001.jpg"
    source_file: str          # original FracAtlas filename
    source_category: str      # "Fractured" | "Non_fractured"
    image_width: int
    image_height: int
    yolo_annotation_file: Optional[str]
    fracture_boxes_yolo: List[List[float]]  # [[xc,yc,w,h], ...]
    fracture_boxes_pixel: List[List[int]]   # [[x1,y1,x2,y2], ...]
    layout_pattern: str
    fields: List[Dict[str, Any]]
    random_seed: int
    has_fracture_overlap: bool
    overlap_group: str        # "A_no_overlap" | "B_fracture_overlap"

# ─────────────────────────────────────────────────────────────────────────────
# Helper: load a PIL font
# ─────────────────────────────────────────────────────────────────────────────
def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()

# ─────────────────────────────────────────────────────────────────────────────
# Helper: YOLO annotation → pixel boxes
# ─────────────────────────────────────────────────────────────────────────────
def load_yolo_annotation(ann_path: Path, img_w: int, img_h: int):
    """Returns (yolo_list, pixel_list). Returns ([], []) if file missing/empty."""
    yolo_boxes, pixel_boxes = [], []
    if not ann_path.exists():
        return yolo_boxes, pixel_boxes
    for line in ann_path.read_text(errors="ignore").splitlines():
        parts = line.strip().split()
        if len(parts) != 5:
            continue
        try:
            _, xc, yc, w, h = [float(p) for p in parts]
        except ValueError:
            continue
        if not all(0.0 <= v <= 1.0 for v in (xc, yc, w, h)):
            continue
        x1 = max(0, int((xc - w / 2) * img_w))
        y1 = max(0, int((yc - h / 2) * img_h))
        x2 = min(img_w, int((xc + w / 2) * img_w))
        y2 = min(img_h, int((yc + h / 2) * img_h))
        yolo_boxes.append([xc, yc, w, h])
        pixel_boxes.append([x1, y1, x2, y2])
    return yolo_boxes, pixel_boxes

# ─────────────────────────────────────────────────────────────────────────────
# Helper: IoU between two [x1,y1,x2,y2] boxes
# ─────────────────────────────────────────────────────────────────────────────
def compute_iou(a: List[int], b: List[int]) -> float:
    ix1 = max(a[0], b[0]); iy1 = max(a[1], b[1])
    ix2 = min(a[2], b[2]); iy2 = min(a[3], b[3])
    inter_w = max(0, ix2 - ix1); inter_h = max(0, iy2 - iy1)
    inter   = inter_w * inter_h
    if inter == 0:
        return 0.0
    area_a  = (a[2]-a[0]) * (a[3]-a[1])
    area_b  = (b[2]-b[0]) * (b[3]-b[1])
    return inter / (area_a + area_b - inter + 1e-6)

def box_intersects(a: List[int], b: List[int]) -> bool:
    return not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])

# ─────────────────────────────────────────────────────────────────────────────
# Synthetic data generators
# ─────────────────────────────────────────────────────────────────────────────
def gen_name(rng: random.Random) -> str:
    return f"{rng.choice(FIRST_NAMES)} {rng.choice(LAST_NAMES)}"

def gen_patient_id(rng: random.Random) -> str:
    return f"SUPMS-P{rng.randint(10000,99999)}"

def gen_mrn(rng: random.Random) -> str:
    return f"MRN-{rng.randint(2020,2026)}-{rng.randint(10000,99999)}"

def gen_dob(rng: random.Random) -> str:
    d = rng.randint(1, 28); m = rng.randint(1, 12); y = rng.randint(1950, 2005)
    return f"{d:02d}/{m:02d}/{y}"

def gen_accession(rng: random.Random) -> str:
    return f"ACC-{rng.randint(20,26)}-{rng.randint(10000,99999)}"

def gen_study_date(rng: random.Random) -> str:
    d = rng.randint(1, 28); m = rng.randint(1, 12); y = rng.randint(2022, 2026)
    return f"{d:02d}/{m:02d}/{y}"

def gen_exam_num(rng: random.Random) -> str:
    return f"EX-{rng.randint(1000,9999)}"

PHI_GENERATORS = {
    "PATIENT_NAME":       lambda rng: ("PATIENT: " + gen_name(rng),         "PATIENT: "),
    "PATIENT_ID":         lambda rng: ("PATIENT ID: " + gen_patient_id(rng), "PATIENT ID: "),
    "MRN":                lambda rng: ("MRN: " + gen_mrn(rng),               "MRN: "),
    "DOB":                lambda rng: ("DOB: " + gen_dob(rng),               "DOB: "),
    "HOSPITAL":           lambda rng: (rng.choice(HOSPITALS),                ""),
    "DEPARTMENT":         lambda rng: ("DEPT: " + rng.choice(DEPARTMENTS),   "DEPT: "),
    "ACCESSION_NUMBER":   lambda rng: ("ACC: " + gen_accession(rng),         "ACC: "),
    "STUDY_DATE":         lambda rng: ("DATE: " + gen_study_date(rng),       "DATE: "),
    "DOCTOR_NAME":        lambda rng: ("REF: " + rng.choice(DOCTORS),        "REF: "),
    "EXAMINATION_NUMBER": lambda rng: ("EXAM: " + gen_exam_num(rng),         "EXAM: "),
}

# ─────────────────────────────────────────────────────────────────────────────
# Layout engine: determine start position based on region & image size
# ─────────────────────────────────────────────────────────────────────────────
def get_start_xy(region: str, img_w: int, img_h: int, block_h: int, block_w_est: int,
                 margin: int) -> Tuple[int, int]:
    if region == "top_left":
        return margin, margin
    elif region == "top_right":
        return max(margin, img_w - block_w_est - margin), margin
    elif region == "bottom_left":
        return margin, max(margin, img_h - block_h - margin)
    elif region == "bottom_right":
        return max(margin, img_w - block_w_est - margin), max(margin, img_h - block_h - margin)
    elif region == "top_center":
        return max(margin, (img_w - block_w_est) // 2), margin
    return margin, margin

# ─────────────────────────────────────────────────────────────────────────────
# Determine whether a position overlaps with image anatomy (bright pixels)
# so we can prefer placing text on dark borders
# ─────────────────────────────────────────────────────────────────────────────
def mean_brightness_in_region(gray: np.ndarray, x1: int, y1: int, x2: int, y2: int) -> float:
    h, w = gray.shape
    x1c, y1c = max(0, x1), max(0, y1)
    x2c, y2c = min(w, x2), min(h, y2)
    if x2c <= x1c or y2c <= y1c:
        return 0.0
    return float(np.mean(gray[y1c:y2c, x1c:x2c]))

# ─────────────────────────────────────────────────────────────────────────────
# Core: render synthetic PHI onto one image
# ─────────────────────────────────────────────────────────────────────────────
def render_phi_on_image(
    src_path: Path,
    dst_path: Path,
    rng: random.Random,
    phi_types: List[str],
    fracture_pixel_boxes: List[List[int]],
    force_overlap: bool = False,
    seed: int = 0,
    img_index: int = 0,
) -> List[PhiField]:
    """
    Renders synthetic PHI labels onto a copy of the image.
    Returns list of PhiField with exact bounding boxes.
    """
    # Load with PIL (preserve mode) and also get grayscale for brightness
    pil_img = Image.open(src_path).convert("RGB")
    img_w, img_h = pil_img.size
    cv_gray = np.array(pil_img.convert("L"))

    # Font size based on image resolution
    if max(img_w, img_h) >= 2000:
        base_size = 28
    elif max(img_w, img_h) >= 1200:
        base_size = 22
    elif max(img_w, img_h) >= 800:
        base_size = 18
    else:
        base_size = 14

    # Robustness subset: last 15 images get slightly harder text
    if img_index >= 85:
        base_size = max(10, base_size - 4)

    font = load_font(base_size)
    draw = ImageDraw.Draw(pil_img)
    margin = max(8, min(img_w, img_h) // 40)

    # Choose layout region — prefer dark borders
    candidate_regions = ["top_left", "top_right", "bottom_left", "bottom_right", "top_center"]
    rng.shuffle(candidate_regions)

    # Estimate text block dimensions for layout
    line_height = base_size + 6
    est_block_h = line_height * len(phi_types) + 10
    est_block_w = max(img_w // 3, 200)

    chosen_region = candidate_regions[0]
    # Prefer region with darkest background
    best_brightness = float("inf")
    for reg in candidate_regions:
        sx, sy = get_start_xy(reg, img_w, img_h, est_block_h, est_block_w, margin)
        brightness = mean_brightness_in_region(cv_gray, sx, sy, sx + est_block_w, sy + est_block_h)
        if brightness < best_brightness:
            best_brightness = brightness
            chosen_region = reg

    # For overlap cases, shift text onto fracture region
    if force_overlap and fracture_pixel_boxes:
        fb = rng.choice(fracture_pixel_boxes)
        # Place text block starting near the fracture box
        start_x = max(margin, fb[0] - 10)
        start_y = max(margin, fb[1] - 5)
    else:
        start_x, start_y = get_start_xy(chosen_region, img_w, img_h,
                                         est_block_h, est_block_w, margin)

    # Determine text color based on background brightness
    bg_bright = mean_brightness_in_region(cv_gray, start_x, start_y,
                                          start_x + est_block_w, start_y + est_block_h)
    if bg_bright < 80:
        text_color = (255, 255, 255)  # white on dark
        bg_treatment = "none"
    elif bg_bright < 160:
        text_color = (220, 220, 220)  # light gray
        bg_treatment = "none"
    else:
        text_color = (10, 10, 10)     # dark on bright
        bg_treatment = "slight_shadow"

    # Robustness: some images get low contrast text
    if img_index >= 85:
        # Low contrast
        if bg_bright < 128:
            text_color = (100, 100, 100)
        else:
            text_color = (160, 160, 160)
        bg_treatment = "low_contrast"

    drawn_fields: List[PhiField] = []
    cy = start_y

    for phi_type in phi_types:
        gen_fn = PHI_GENERATORS.get(phi_type)
        if gen_fn is None:
            continue
        text_str, _prefix = gen_fn(rng)

        # Get text bounding box
        try:
            bbox_obj = font.getbbox(text_str)
            tw = bbox_obj[2] - bbox_obj[0]
            th = bbox_obj[3] - bbox_obj[1]
        except AttributeError:
            tw = len(text_str) * (base_size // 2)
            th = base_size

        x1 = start_x
        y1 = cy
        x2 = min(img_w, x1 + tw + 6)
        y2 = min(img_h, y1 + th + 4)

        # Draw slight background strip for readability if needed
        if bg_treatment in ("slight_shadow", "low_contrast"):
            shadow_color = (0, 0, 0) if bg_bright > 128 else (40, 40, 40)
            draw.rectangle([x1 - 1, y1 - 1, x2 + 1, y2 + 1], fill=shadow_color)

        draw.text((x1, y1), text_str, fill=text_color, font=font)

        # Compute fracture overlap
        phi_box = [x1, y1, x2, y2]
        has_overlap = False
        max_iou = 0.0
        overlapping_ids = []
        for fid, fb in enumerate(fracture_pixel_boxes):
            if box_intersects(phi_box, fb):
                has_overlap = True
                iou = compute_iou(phi_box, fb)
                max_iou = max(max_iou, iou)
                overlapping_ids.append(fid)

        drawn_fields.append(PhiField(
            type=phi_type,
            text=text_str,
            bbox=phi_box,
            placement_region=chosen_region,
            font_size=base_size,
            text_color=list(text_color),
            background_treatment=bg_treatment,
            fracture_overlap=has_overlap,
            fracture_iou=round(max_iou, 4),
            fracture_annotation_ids=overlapping_ids,
            random_seed=seed,
        ))

        cy += line_height

    # Save contaminated image — never overwrite original
    pil_img.save(str(dst_path), quality=95)
    return drawn_fields

# ─────────────────────────────────────────────────────────────────────────────
# Main pipeline
# ─────────────────────────────────────────────────────────────────────────────
def run(seed: int = 42, count: int = 100):
    rng = random.Random(seed)

    # Collect available images
    fractured_imgs   = sorted(FRACTURED_DIR.glob("*.jpg")) + sorted(FRACTURED_DIR.glob("*.png"))
    non_frac_imgs    = sorted(NON_FRAC_DIR.glob("*.jpg"))  + sorted(NON_FRAC_DIR.glob("*.png"))

    if not fractured_imgs:
        sys.exit(f"ERROR: No images found in {FRACTURED_DIR}")
    if not non_frac_imgs:
        sys.exit(f"ERROR: No images found in {NON_FRAC_DIR}")

    # 30% from Fractured, 70% from Non_fractured
    n_frac    = max(1, int(count * 0.30))
    n_nonfrac = count - n_frac

    rng_copy = random.Random(seed)
    selected_frac    = rng_copy.sample(fractured_imgs,  min(n_frac, len(fractured_imgs)))
    selected_nonfrac = rng_copy.sample(non_frac_imgs,   min(n_nonfrac, len(non_frac_imgs)))

    selected = [(p, "Fractured")     for p in selected_frac] + \
               [(p, "Non_fractured") for p in selected_nonfrac]
    rng_copy.shuffle(selected)
    selected = selected[:count]

    all_annotations: List[ImageAnnotation] = []
    manifest_rows = []

    print(f"\n{'='*60}")
    print(f"  SUPMS-Fair Synthetic PHI Benchmark")
    print(f"  Seed: {seed} | Count: {len(selected)}")
    print(f"  Fractured: {n_frac}  |  Non-fractured: {n_nonfrac}")
    print(f"{'='*60}\n")

    for img_index, (src_path, category) in enumerate(selected):
        img_num    = img_index + 1
        img_id     = f"{img_num:03d}.jpg"
        img_seed   = seed + img_index * 7

        img_rng = random.Random(img_seed)

        # Copy original (never modified)
        orig_dst = ORIGINAL_DIR / img_id
        shutil.copy2(src_path, orig_dst)

        # Load image to get dimensions
        try:
            pil_tmp = Image.open(src_path)
            img_w, img_h = pil_tmp.size
            pil_tmp.close()
        except Exception as e:
            print(f"  [SKIP] {src_path.name}: cannot open — {e}")
            continue

        # Load YOLO annotation
        ann_stem  = src_path.stem
        ann_path  = YOLO_ANNOT_DIR / f"{ann_stem}.txt"
        yolo_boxes, pixel_boxes = load_yolo_annotation(ann_path, img_w, img_h)

        # Decide overlap strategy
        # First n_frac images are from Fractured, force at least one overlap field
        force_overlap = (category == "Fractured") and bool(pixel_boxes)

        # Choose PHI combo
        phi_types = list(img_rng.choice(PHI_COMBOS))

        # Contaminated output path
        contam_dst = CONTAM_DIR / f"{img_num:03d}_phi.jpg"

        try:
            drawn_fields = render_phi_on_image(
                src_path=src_path,
                dst_path=contam_dst,
                rng=img_rng,
                phi_types=phi_types,
                fracture_pixel_boxes=pixel_boxes,
                force_overlap=force_overlap,
                seed=img_seed,
                img_index=img_index,
            )
        except Exception as e:
            print(f"  [ERROR] {src_path.name}: {e}")
            continue

        has_any_overlap  = any(f.fracture_overlap for f in drawn_fields)
        overlap_group    = "B_fracture_overlap" if has_any_overlap else "A_no_overlap"

        ann = ImageAnnotation(
            image_id=img_id,
            source_file=src_path.name,
            source_category=category,
            image_width=img_w,
            image_height=img_h,
            yolo_annotation_file=str(ann_path.relative_to(FRACATLAS_ROOT)) if ann_path.exists() else None,
            fracture_boxes_yolo=yolo_boxes,
            fracture_boxes_pixel=pixel_boxes,
            layout_pattern=drawn_fields[0].placement_region if drawn_fields else "unknown",
            fields=[asdict(f) for f in drawn_fields],
            random_seed=img_seed,
            has_fracture_overlap=has_any_overlap,
            overlap_group=overlap_group,
        )
        all_annotations.append(ann)

        # Per-image JSON ground truth
        per_img_gt = GT_DIR / f"{img_num:03d}.json"
        per_img_gt.write_text(json.dumps(asdict(ann), indent=2))

        # Manifest row
        manifest_rows.append({
            "img_num":          img_num,
            "image_id":         img_id,
            "source_file":      src_path.name,
            "category":         category,
            "image_width":      img_w,
            "image_height":     img_h,
            "phi_fields":       len(drawn_fields),
            "phi_types":        "|".join(f.type for f in drawn_fields),
            "layout":           ann.layout_pattern,
            "has_fracture_overlap": has_any_overlap,
            "overlap_group":    overlap_group,
            "has_yolo_ann":     bool(yolo_boxes),
            "fracture_boxes":   len(pixel_boxes),
            "seed":             img_seed,
        })

        status = "FRAC-OVERLAP" if force_overlap else "NO-OVERLAP"
        print(f"  [{img_num:03d}/{len(selected)}] {src_path.name:30s} | {category:15s} | "
              f"{len(drawn_fields)} PHI | {status}")

    # Save combined ground truth JSON
    combined_gt = GT_DIR / "annotations.json"
    combined_gt.write_text(json.dumps(
        [asdict(a) for a in all_annotations], indent=2
    ))

    # Save dataset manifest CSV
    manifest_path = META_DIR / "dataset_manifest.csv"
    if manifest_rows:
        with open(manifest_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=list(manifest_rows[0].keys()))
            writer.writeheader()
            writer.writerows(manifest_rows)

    total_fields = sum(r["phi_fields"] for r in manifest_rows)
    print(f"\n{'='*60}")
    print(f"  GENERATION COMPLETE")
    print(f"  Images processed : {len(manifest_rows)}")
    print(f"  Total PHI fields : {total_fields}")
    print(f"  Fracture-overlap : {sum(1 for r in manifest_rows if r['has_fracture_overlap'])}")
    print(f"  No-overlap       : {sum(1 for r in manifest_rows if not r['has_fracture_overlap'])}")
    print(f"  Ground truth     : {combined_gt}")
    print(f"  Manifest         : {manifest_path}")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="SUPMS-Fair Synthetic PHI Generator")
    parser.add_argument("--seed",  type=int, default=42,  help="Random seed for reproducibility")
    parser.add_argument("--count", type=int, default=100, help="Number of images to generate")
    args = parser.parse_args()
    run(seed=args.seed, count=args.count)

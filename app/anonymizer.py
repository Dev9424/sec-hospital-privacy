import io, uuid, cv2, os
import numpy as np
from PIL import Image
from dataclasses import dataclass, asdict
from typing import List, Dict

from .phi_classifier import classify
from .models import Box
from .ocr import detect_text
from .fracatlas import load_yolo_boxes

def scrub_metadata(data):
    with Image.open(io.BytesIO(data)) as im:
        out=io.BytesIO()
        im.convert("RGB").save(out,"JPEG",quality=95,optimize=True)
        return out.getvalue()

def anonymize(image,ocr_regions,fracture_boxes):
    out = image.copy()
    redacted = []
    review = []
    
    n = len(ocr_regions)
    i = 0
    while i < n:
        r = ocr_regions[i]
        line_num = r.line_num
        block_num = r.block_num
        
        line_indices = [
            j for j in range(n)
            if ocr_regions[j].line_num == line_num and ocr_regions[j].block_num == block_num
        ]
        
        # Build line text
        line_text = " ".join(ocr_regions[j].text for j in line_indices)
        label, risk = classify(line_text, min([ocr_regions[j].confidence for j in line_indices]))
        
        if label == "PHI" or any(k in line_text.lower() for k in ["patient", "id", "dob", "name"]):
            for j in line_indices:
                lr = ocr_regions[j]
                pad = max(3, round(min(lr.box.x2 - lr.box.x1, lr.box.y2 - lr.box.y1) * 0.25))
                b = Box(max(0, lr.box.x1 - pad), max(0, lr.box.y1 - pad),
                        min(out.shape[1], lr.box.x2 + pad), min(out.shape[0], lr.box.y2 + pad))
                
                hits = [f for f in fracture_boxes if b.intersection(f)]
                if hits:
                    review.append({"box": b.to_dict(), "reason": "PHI intersects protected fracture region",
                                   "risk_score": risk, "protected_regions": [f.to_dict() for f in hits]})
                else:
                    cv2.rectangle(out, (b.x1, b.y1), (b.x2, b.y2), (0, 0, 0), -1)
                    redacted.append({"box": b.to_dict(), "risk_score": risk})
            
            i = max(line_indices) + 1
            continue
            
        i += 1
        
    return out, redacted, review

def encode_jpeg(image):
    ok,e=cv2.imencode(".jpg",image,[int(cv2.IMWRITE_JPEG_QUALITY),95])
    if not ok: raise RuntimeError("JPEG encoding failed")
    return e.tobytes()

def new_filename(): return "anon_"+uuid.uuid4().hex+".jpg"

# Helper function for tests
def boxes_intersect(box_a: tuple[int, int, int, int], box_b: tuple[int, int, int, int]) -> bool:
    """Return True if two axis-aligned boxes intersect.
    Boxes are (x1, y1, x2, y2)."""
    ax1, ay1, ax2, ay2 = box_a
    bx1, by1, bx2, by2 = box_b
    return not (ax2 <= bx1 or bx2 <= ax1 or ay2 <= by1 or by2 <= ay1)

@dataclass
class AnonymizeResult:
    ocr_regions_detected: int
    phi_regions_detected: int
    redacted_regions: int
    protected_fracture_regions: int
    status: str
    errors: List[str]

    def model_dump(self):
        return asdict(self)

def anonymize_image(image_path: str) -> AnonymizeResult:
    """Load an image, run the anonymization pipeline, and return summary."""
    if not os.path.exists(image_path):
        return AnonymizeResult(0,0,0,0,"error",[f"File not found: {image_path}"])
    
    with open(image_path, "rb") as f:
        raw = f.read()
    
    data = scrub_metadata(raw)
    img_array = np.frombuffer(data, dtype=np.uint8)
    image = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
    
    if image is None:
        return AnonymizeResult(0,0,0,0,"error",["Unable to decode image"])
        
    h, w = image.shape[:2]
    
    annotation_path = None
    possible_txt = os.path.splitext(image_path)[0] + ".txt"
    if os.path.isfile(possible_txt):
        annotation_path = possible_txt
        
    fracture_boxes = load_yolo_boxes(annotation_path, w, h) if annotation_path else []
    ocr_regions = detect_text(image)
    out_image, redacted, review = anonymize(image, ocr_regions, fracture_boxes)
    
    ocr_cnt = len(ocr_regions)
    phi_cnt = len(redacted) + len(review)
    
    result = AnonymizeResult(
        ocr_regions_detected=ocr_cnt,
        phi_regions_detected=phi_cnt,
        redacted_regions=len(redacted),
        protected_fracture_regions=len(fracture_boxes),
        status="manual_review_required" if review else "success",
        errors=[]
    )
    return result

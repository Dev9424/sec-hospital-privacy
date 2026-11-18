import cv2
import pytesseract
import numpy as np
from typing import List, Dict
from app.config import TESSERACT_PATH, TESSDATA_PATH, OCR_MIN_CONFIDENCE
from app.models import TextRegion
from app.phi_classifier import classify_text

# Explicitly set Tesseract paths
pytesseract.pytesseract.tesseract_cmd = str(TESSERACT_PATH)
TESSDATA_CONFIG = f'--tessdata-dir "{TESSDATA_PATH}"'

def preprocess_image(image_bgr: np.ndarray, scale: float = 2.0) -> np.ndarray:
    """
    Enhance image for OCR.
    """
    # Resize
    width = int(image_bgr.shape[1] * scale)
    height = int(image_bgr.shape[0] * scale)
    resized = cv2.resize(image_bgr, (width, height), interpolation=cv2.INTER_CUBIC)
    
    # Grayscale
    gray = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)
    
    # CLAHE for contrast
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    
    return enhanced

def merge_boxes(boxes: List[TextRegion]) -> List[TextRegion]:
    """
    Merge heavily overlapping bounding boxes.
    Very simplistic merge: if one box is completely inside another, keep the larger or higher confidence.
    For now, we just return all unique non-overlapping/merged boxes.
    (A robust implementation would compute IoU, but for this MVP we'll just keep all and rely on redaction).
    """
    # For now, return all to ensure we don't miss PHI. Redacting overlapping boxes is safe.
    return boxes

def detect_text_regions(image_path: str) -> List[TextRegion]:
    """
    Run OCR and return detected text regions with bounding boxes mapped back to original image coordinates.
    """
    img = cv2.imread(image_path)
    if img is None:
        raise ValueError(f"Could not read image: {image_path}")
        
    scale_factor = 2.0
    processed = preprocess_image(img, scale=scale_factor)
    
    # Run Tesseract
    data = pytesseract.image_to_data(processed, config=TESSDATA_CONFIG, output_type=pytesseract.Output.DICT)
    
    regions = []
    
    for i in range(len(data['text'])):
        conf = float(data['conf'][i])
        text = data['text'][i].strip()
        
        # Filter low confidence and empty text
        if conf < OCR_MIN_CONFIDENCE or not text:
            continue
            
        # Coordinates in processed image
        x_proc = data['left'][i]
        y_proc = data['top'][i]
        w_proc = data['width'][i]
        h_proc = data['height'][i]
        
        # Map back to original image
        x = int(x_proc / scale_factor)
        y = int(y_proc / scale_factor)
        w = int(w_proc / scale_factor)
        h = int(h_proc / scale_factor)
        
        classification, reason = classify_text(text)
        
        # Default policy: redact if POTENTIAL_PHI
        # We don't automatically redact UNKNOWN unless strictly configured
        should_redact = (classification == "POTENTIAL_PHI")
        
        regions.append(TextRegion(
            text=text,
            confidence=conf,
            x=x,
            y=y,
            width=w,
            height=h,
            x1=x,
            y1=y,
            x2=x + w,
            y2=y + h,
            classification=classification,
            reason=reason,
            should_redact=should_redact
        ))
        
    return merge_boxes(regions)

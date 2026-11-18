import os
import io
import cv2
import numpy as np
import pytest
import hashlib
from PIL import Image
from pathlib import Path

from app.phi_classifier import classify
from app.fracatlas import load_yolo_boxes, yolo_to_box
from app.models import Box, OCRRegion
from app.anonymizer import scrub_metadata, anonymize, boxes_intersect, anonymize_image
from app.ocr import TESSERACT_CMD, TESSDATA_DIR

# ---------------------------------------------------------
# Configuration Tests
# ---------------------------------------------------------
def test_tesseract_configuration():
    assert TESSERACT_CMD == r"D:\sec hospital\mtech project ref\tesseract.exe"
    assert TESSDATA_DIR == r"D:\sec hospital\mtech project ref\tessdata"
    assert os.path.exists(TESSERACT_CMD), "Tesseract executable must exist"

# ---------------------------------------------------------
# PHI Classification Tests
# ---------------------------------------------------------
def test_phi_classification_unsafe():
    unsafe_strings = [
        "Patient ID: 123456",
        "Patient Name: John Doe",
        "DOB: 12/04/2001",
        "Phone: 9876543210",
        "MRN: MRN123456",
        "ID: 12345678"
    ]
    for s in unsafe_strings:
        label, risk = classify(s, 0.99)
        assert label == "PHI", f"Expected PHI for {s}"

def test_phi_classification_safe():
    safe_strings = ["LEFT", "RIGHT", "L", "R", "AP", "LAT", "TIBIA", "WRIST", "FOREARM", "CHEST", "PA"]
    for s in safe_strings:
        label, risk = classify(s, 0.99)
        assert label == "SAFE", f"Expected SAFE for {s}"

# ---------------------------------------------------------
# YOLO Mapping Tests
# ---------------------------------------------------------
def test_yolo_coordinate_conversion():
    # class x_center y_center width height
    box = yolo_to_box(0.5, 0.5, 0.2, 0.2, 1000, 1000)
    assert box.x1 == 400
    assert box.y1 == 400
    assert box.x2 == 600
    assert box.y2 == 600

def test_invalid_yolo_annotations(tmp_path):
    ann_file = tmp_path / "test.txt"
    ann_file.write_text("invalid line\n1 0.5 0.5 0.2\n") # missing height
    boxes = load_yolo_boxes(str(ann_file), 1000, 1000)
    assert len(boxes) == 0

# ---------------------------------------------------------
# Geometry / Collision Tests
# ---------------------------------------------------------
def test_collision_detection():
    # box is x1, y1, x2, y2
    assert boxes_intersect((0, 0, 10, 10), (15, 15, 20, 20)) is False # No intersection
    assert boxes_intersect((0, 0, 10, 10), (5, 5, 15, 15)) is True    # Partial
    assert boxes_intersect((0, 0, 10, 10), (2, 2, 8, 8)) is True      # Complete (inside)
    assert boxes_intersect((2, 2, 8, 8), (0, 0, 10, 10)) is True      # Inside (reverse)

    phi_box = Box(0, 0, 10, 10)
    frac_box = Box(5, 5, 15, 15)
    assert phi_box.intersection(frac_box) is not None

def test_collision_fail_closed():
    # If PHI overlaps a fracture protection region, do NOT simply mask the fracture.
    # It must fail closed and flag for manual review.
    image = np.zeros((100, 100, 3), dtype=np.uint8)
    ocr = [OCRRegion(Box(0, 0, 20, 20), "Patient ID: 123", 0.99)]
    fractures = [Box(10, 10, 30, 30)]
    
    out, redacted, review = anonymize(image, ocr, fractures)
    
    assert len(redacted) == 0, "Should not redact when colliding with fracture"
    assert len(review) == 1, "Should flag for review"
    assert review[0]["reason"] == "PHI intersects protected fracture region"

# ---------------------------------------------------------
# Redaction Tests
# ---------------------------------------------------------
def test_image_redaction():
    image = np.ones((100, 100, 3), dtype=np.uint8) * 255
    ocr = [OCRRegion(Box(10, 10, 30, 30), "PATIENT ID: 123456", 0.99)]
    fractures = [] # No collisions
    
    out, redacted, review = anonymize(image, ocr, fractures)
    
    assert len(redacted) == 1
    assert len(review) == 0
    # Check that region is black
    b = redacted[0]["box"]
    region = out[b['y1']:b['y2'], b['x1']:b['x2']]
    assert np.all(region == 0), "Region should be redacted (black)"

# ---------------------------------------------------------
# Metadata Scrubbing Tests
# ---------------------------------------------------------
def test_metadata_scrubbing():
    # Create a dummy image in memory
    img = Image.new("RGB", (50, 50), color="white")
    # In a real scenario we'd inject EXIF, but PIL strips it when saving as JPEG
    # We will simulate reading/writing via scrub_metadata
    buf = io.BytesIO()
    img.save(buf, format="PNG", pnginfo=None) # Start with PNG
    
    scrubbed_bytes = scrub_metadata(buf.getvalue())
    scrubbed_img = Image.open(io.BytesIO(scrubbed_bytes))
    
    assert scrubbed_img.format == "JPEG", "Output must be strictly JPEG"
    assert "exif" not in scrubbed_img.info, "EXIF must be stripped"

# ---------------------------------------------------------
# Dataset Integrity Tests
# ---------------------------------------------------------
def test_dataset_integrity():
    target_img = r"D:\sec hospital\mtech project ref\FracAtlas\images\Fractured\IMG0000142.jpg"
    if not os.path.exists(target_img):
        pytest.skip(f"Test image not found at {target_img}")
        
    with open(target_img, "rb") as f:
        original_hash = hashlib.sha256(f.read()).hexdigest()
        
    # Run the pipeline
    result = anonymize_image(target_img)
    
    # Check again
    with open(target_img, "rb") as f:
        new_hash = hashlib.sha256(f.read()).hexdigest()
        
    assert original_hash == new_hash, "Original dataset file was modified!"
    assert result.status in ["success", "manual_review_required"]

from pydantic import BaseModel
from typing import List, Optional

class TextRegion(BaseModel):
    text: str
    confidence: float
    x: int
    y: int
    width: int
    height: int
    x1: int
    y1: int
    x2: int
    y2: int
    classification: str  # SAFE_MEDICAL_TEXT, POTENTIAL_PHI, UNKNOWN
    reason: str
    should_redact: bool

class FractureRegion(BaseModel):
    class_id: int
    x: float
    y: float
    width: float
    height: float
    x1: int
    y1: int
    x2: int
    y2: int

class ValidationStatus(BaseModel):
    output_readable: bool
    dimensions_preserved: bool
    fracture_protection_passed: bool
    post_ocr_validation: bool

class AnonymizationResult(BaseModel):
    success: bool
    status: str
    input_filename: str
    output_path: Optional[str] = None
    image_width: int
    image_height: int
    ocr_regions_detected: int
    phi_regions_detected: int
    redacted_regions: int
    protected_fracture_regions: int
    validation: Optional[ValidationStatus] = None
    warnings: List[str] = []
    errors: List[str] = []

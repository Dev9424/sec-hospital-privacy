import re
from typing import Tuple

# Safe anatomical and radiographic terms
SAFE_TERMS = {
    "l", "r", "ap", "pa", "lat", "b/v", "bv", 
    "forearm", "wrist", "hand", "elbow", "shoulder", 
    "humerus", "radius", "ulna", "tibia", "fibula", 
    "knee", "ankle", "foot", "chest", "spine", "pelvis",
    "left", "right", "anterior", "posterior", "lateral",
    "oblique", "supine", "erect", "portable",
    "x-ray", "xray", "film"
}

# Regex for detecting common PHI
PHI_PATTERNS = [
    # DOB or generic Date
    r'\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b', 
    r'\b\d{4}[/-]\d{1,2}[/-]\d{1,2}\b',
    # Phone numbers
    r'\b\d{10}\b',
    r'\+\d{1,3}[\s-]?\d{10}\b',
    # MRN or ID (alphanumeric sequence containing numbers)
    r'\b[A-Z0-9]+[0-9]{4,}[A-Z0-9]*\b',
    # "MRN" or "ID" followed by numbers
    r'\b(?:MRN|ID|PATIENT|NO)[\s:]*\d+\b',
]

def normalize_text(text: str) -> str:
    """Normalize text for classification: lowercase, strip punctuation except slashes/hyphens."""
    text = text.lower().strip()
    # Remove all punctuation except slashes, hyphens, and spaces
    text = re.sub(r'[^\w\s/-]', '', text)
    # Collapse multiple spaces
    text = re.sub(r'\s+', ' ', text)
    return text.strip()

def classify_text(text: str) -> Tuple[str, str]:
    """
    Classify text into SAFE_MEDICAL_TEXT, POTENTIAL_PHI, or UNKNOWN.
    Returns (classification, reason).
    """
    if not text.strip():
        return "UNKNOWN", "Empty text"
    
    norm_text = normalize_text(text)
    
    # 1. Check if entirely in safe terms
    # Split the text by spaces and check if all tokens are safe
    tokens = norm_text.split()
    if all(token in SAFE_TERMS for token in tokens if token):
        return "SAFE_MEDICAL_TEXT", "Matches safe anatomical/radiographic whitelist"
    
    # Check if exact match for some compound safe terms (e.g., "forearm b/v")
    if norm_text in SAFE_TERMS:
        return "SAFE_MEDICAL_TEXT", "Matches safe anatomical whitelist exactly"
        
    # 2. Check PHI patterns
    for pattern in PHI_PATTERNS:
        if re.search(pattern, text, re.IGNORECASE):
            return "POTENTIAL_PHI", f"Matches PHI regex pattern"
    
    # 3. Check for obvious institution names (Hospital, Clinic)
    if re.search(r'\b(hospital|clinic|center|medical|institute)\b', text, re.IGNORECASE):
        return "POTENTIAL_PHI", "Matches institution identifier (e.g. Clinic/Hospital)"
    
    # 4. Unknown
    return "UNKNOWN", "Does not match safe whitelist or known PHI patterns"

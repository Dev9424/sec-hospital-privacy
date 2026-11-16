import re

SAFE={"L","R","AP","PA","LAT","LAT.","LEFT","RIGHT","WRIST","HAND","ELBOW",
      "FOREARM","HUMERUS","KNEE","ANKLE","FOOT","TIBIA","FIBULA","FEMUR","CHEST"}
DATE=re.compile(r"\b(?:\d{1,2}[/-]){1,2}\d{2,4}\b|\b\d{4}[/-]\d{1,2}[/-]\d{1,2}\b")
PHONE=re.compile(r"\b(?:\+?\d[\d .()-]{7,}\d)\b")
ID=re.compile(r"\b(?:ID|MRN|UHID|PATIENT|PATIENTID|ACC|ACCESSION)\s*[:#-]?\s*[A-Z0-9-]{3,}\b",re.I)
NAME=re.compile(r"\b(?:NAME|PATIENT NAME)\s*[:#-]?\s*.+",re.I)
DOB=re.compile(r"\b(?:DOB|D\.O\.B\.|BIRTH)\s*[:#-]?",re.I)
ALNUM=re.compile(r"\b[A-Z]{1,4}[-/]?\d{4,12}\b",re.I)

def classify(text,confidence):
    t=" ".join(text.strip().split()); u=t.upper()
    if not t: return "EMPTY",0.0
    if u in SAFE: return "SAFE",0.0
    if NAME.search(t) or DOB.search(t): return "PHI",0.99
    if ID.search(t): return "PHI",0.98
    if DATE.search(t): return "PHI",0.92
    if PHONE.search(t): return "PHI",0.99
    if ALNUM.search(t): return "PHI",0.86
    if len(u)<=3 and u.replace(".","").isalpha() and confidence>=.65: return "SAFE",0
    # Text that matches no PHI pattern and has high OCR confidence (>=0.65) is unlikely to be PHI.
    # REVIEW applies only in the low/medium confidence band (< 0.65).
    if confidence >= 0.65: return "SAFE", 0.0
    return ("REVIEW",.45) if confidence<.45 else ("REVIEW",.55)

def classify_text(text: str) -> tuple[str, float]:
    """Text-only PHI classifier (no OCR confidence parameter).

    Does NOT call classify() to avoid the confidence-based SAFE fallback
    that is only meaningful in the image-OCR context.

    Returns:
        ("SAFE_MEDICAL_TEXT", 0.0)  – at least one word is a whitelisted
                                      anatomical / orientation term.
        ("POTENTIAL_PHI",   score)  – a PHI pattern matched.
        ("UNKNOWN",          0.0)   – no pattern matched; human review advised.
    """
    t = " ".join(text.strip().split())
    u = t.upper()
    if not t:
        return "EMPTY", 0.0

    # 1. Whitelist: any whitespace-delimited word (or its de-dotted form)
    #    is a known-safe anatomical / orientation term.
    if any(w in SAFE or w.rstrip(".") in SAFE for w in u.split()):
        return "SAFE_MEDICAL_TEXT", 0.0

    # 2. PHI pattern checks – same regexes as classify(), no confidence needed.
    if NAME.search(t) or DOB.search(t):
        return "POTENTIAL_PHI", 0.99
    if ID.search(t):
        return "POTENTIAL_PHI", 0.98
    if DATE.search(t):
        return "POTENTIAL_PHI", 0.92
    if PHONE.search(t):
        return "POTENTIAL_PHI", 0.99
    if ALNUM.search(t):
        return "POTENTIAL_PHI", 0.86

    # 3. No pattern matched.
    return "UNKNOWN", 0.0

"""
text_anonymization.py
----------------------
SUPMS-Fair : Text Anonymization Module (Objective 1)

Pipeline:
 1. NER-based PHI redaction (spaCy)     -> names, orgs, locations
 2. Regex-based redaction               -> phone numbers, IDs, dates
 3. Generalization                      -> keeps dates/locations useful but vague
 4. Fair Differential Privacy noise     -> numeric lab values (Laplace Mechanism,
                                            noise scaled by patient subgroup size)

Run:
    pip install -r requirements.txt
    python -m spacy download en_core_web_sm
    python text_anonymization.py
"""

import re
import random
import math

import spacy

# ---------------------------------------------------------------------------
# 1. Load spaCy model (run once)
# ---------------------------------------------------------------------------
# en_core_web_sm detects PERSON, ORG, GPE (location), DATE out of the box.
# For higher medical accuracy later, you can swap this for a clinical model
# (e.g., en_core_sci_sm from scispaCy) without changing the rest of the code.
nlp = spacy.load("en_core_web_sm")


# ---------------------------------------------------------------------------
# 2. Regex patterns for structured PHI that NER often misses
# ---------------------------------------------------------------------------
REGEX_PATTERNS = {
    "PHONE": re.compile(r"\b(?:\+?\d{1,3}[-.\s]?)?\d{10}\b"),
    "PATIENT_ID": re.compile(r"\b(?:PT|MRN|ID)[-#]?\d{3,8}\b", re.IGNORECASE),
    "EMAIL": re.compile(r"\b[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}\b"),
    "DATE_NUMERIC": re.compile(r"\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b"),
}


def redact_regex(text: str) -> str:
    """Pass 1: redact structured patterns regex is good at."""
    for label, pattern in REGEX_PATTERNS.items():
        text = pattern.sub(f"[{label}]", text)
    return text


# ---------------------------------------------------------------------------
# 3. Clinical entity allowlist & Cued Name Pass (Step 5 Improvements)
# ---------------------------------------------------------------------------
CLINICAL_ALLOWLIST = {
    "radius", "distal radius", "ulna", "scaphoid", "carpal", "metacarpal",
    "femur", "tibia", "fibula", "patella", "tarsal", "metatarsal", "ankle",
    "humerus", "clavicle", "scapula", "shoulder", "elbow", "wrist", "hip", "knee",
    "pelvis", "spine", "vertebra", "cervical", "thoracic", "lumbar", "sacrum",
    "rib", "sternum", "chest", "thorax", "hemithorax", "lung", "lungs",
    "fracture", "effusion", "pleural effusion", "consolidation", "pneumothorax",
    "edema", "dislocation", "subluxation", "infiltrate", "callus", "cortical",
    "cortex", "trabecular", "alignment", "joint", "soft tissue", "hematoma",
    "normal", "acute", "chronic", "mild", "moderate", "severe", "stable",
    "healing", "healed", "displaced", "undisplaced", "angulated", "comminuted",
    "wbc", "rbc", "platelets", "platelet", "hemoglobin", "hb", "glucose"
}

_ANATOMICAL_MODIFIERS = {"left", "right", "distal", "proximal", "mid", "bilateral", "anterior", "posterior"}

def is_clinical_allowlisted(ent_text: str) -> bool:
    """Check if an entity text corresponds to anatomical sites or clinical terms."""
    clean = ent_text.strip().lower()
    if clean in CLINICAL_ALLOWLIST:
        return True
    words = [w for w in re.split(r"\W+", clean) if w]
    if not words:
        return False
    return all(w in CLINICAL_ALLOWLIST or w in _ANATOMICAL_MODIFIERS for w in words)


CUED_NAME_PATTERNS = [
    re.compile(r"\b(Patient\s+)([A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*)?)\b"),
    re.compile(r"\b((?:Mr\.|Mrs\.|Ms\.|Miss)\s+)([A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*)?)\b"),
    re.compile(r"\b(Dr\.\s+)([A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*)?)\b"),
    re.compile(r"\b((?:Patient\s+)?Name\s*[:\-]\s*)([A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*)?)\b", re.IGNORECASE),
]

def redact_cued_names(text: str) -> str:
    """
    Pass 1.5: rule-based name redaction using honorific and label cues.
    Safely captures Indian first and last names that generic spaCy NER often misses
    (e.g., 'Patient Ramesh Kumar' -> 'Patient [PATIENT_NAME]').
    Preserves clinical terms if preceded by a cue.
    """
    for pattern in CUED_NAME_PATTERNS:
        def repl(match):
            prefix = match.group(1)
            candidate = match.group(2)
            if is_clinical_allowlisted(candidate):
                return match.group(0)
            return f"{prefix}[PATIENT_NAME]"
        text = pattern.sub(repl, text)
    return text


# ---------------------------------------------------------------------------
# 3b. NER-based redaction (catches free-text names, locations, orgs)
# ---------------------------------------------------------------------------
NER_LABEL_MAP = {
    "PERSON": "[PATIENT_NAME]",
    "GPE": "[LOCATION]",       # cities, countries
    "LOC": "[LOCATION]",
    "ORG": "[HOSPITAL/ORG]",
    "DATE": "[DATE]",
}


def redact_ner(text: str) -> str:
    """Pass 2: run spaCy NER and replace detected entities with placeholders,
    preserving anatomical/clinical terms in the allowlist."""
    doc = nlp(text)
    redacted = text
    # Replace from the end of the string backwards so character offsets
    # don't shift while we edit.
    for ent in sorted(doc.ents, key=lambda e: e.start_char, reverse=True):
        if ent.label_ in NER_LABEL_MAP:
            # Skip if entity text is part of an already-inserted placeholder like [PATIENT_NAME]
            if "[" in ent.text or "]" in ent.text:
                continue
            # Step 5: Check allowlist — do not redact anatomical sites/clinical terms
            if is_clinical_allowlisted(ent.text):
                continue
            placeholder = NER_LABEL_MAP[ent.label_]
            redacted = redacted[: ent.start_char] + placeholder + redacted[ent.end_char :]
    return redacted


# ---------------------------------------------------------------------------
# 4. Fair Differential Privacy — Laplace Mechanism with group-scaled noise
# ---------------------------------------------------------------------------
def laplace_noise(scale: float) -> float:
    """Sample noise from a Laplace distribution with the given scale (b)."""
    u = random.uniform(-0.5, 0.5)
    return -scale * math.copysign(1, u) * math.log(1 - 2 * abs(u))


def fair_dp_noise(value: float, base_noise: float, largest_group_size: int,
                   current_group_size: int) -> float:
    """
    Core Fair-DP formula from the project:
        sigma = base_noise * (largest_group_size / current_group_size)

    Small subgroups (current_group_size small) => larger sigma => more noise
    => stronger protection. Large/common subgroups get less noise, preserving
    more utility since they are already naturally harder to re-identify.
    """
    sigma = base_noise * (largest_group_size / current_group_size)
    noisy_value = value + laplace_noise(sigma)
    return noisy_value


def bucket_numeric_value(value: float, noisy_value: float, bucket_width: float = 1500) -> str:
    """Convert an exact noisy number into a clinically readable range/bucket."""
    lower = round((noisy_value - bucket_width / 2) / 100) * 100
    upper = round((noisy_value + bucket_width / 2) / 100) * 100
    return f"{int(lower):,}-{int(upper):,}"


# Numbers that look like lab values in free text, e.g. "WBC: 12500" or "WBC 12,500"
LAB_VALUE_PATTERN = re.compile(r"\b(WBC|RBC|Platelets?|Hemoglobin|Hb|Glucose)\s*[:\-]?\s*([\d,]{3,7})\b",
                                re.IGNORECASE)


def apply_dp_to_numeric_values(text: str, base_noise: float, largest_group_size: int,
                                current_group_size: int) -> str:
    """Pass 3: find lab values in text and replace exact numbers with a DP-noised range."""

    def replacer(match):
        label = match.group(1)
        raw_value = float(match.group(2).replace(",", ""))
        noisy_value = fair_dp_noise(raw_value, base_noise, largest_group_size, current_group_size)
        bucketed = bucket_numeric_value(raw_value, noisy_value)
        return f"{label}: {bucketed}"

    return LAB_VALUE_PATTERN.sub(replacer, text)


# ---------------------------------------------------------------------------
# 5. Full pipeline
# ---------------------------------------------------------------------------
def anonymize_clinical_note(text: str, base_noise: float = 300,
                             largest_group_size: int = 1000,
                             current_group_size: int = 1000) -> str:
    """
    Full text anonymization pipeline:
    regex redaction -> Fair-DP noise on numeric lab values -> cued name redaction -> NER redaction (with clinical allowlist)
    """
    step1 = redact_regex(text)
    step2 = apply_dp_to_numeric_values(step1, base_noise, largest_group_size, current_group_size)
    step3 = redact_cued_names(step2)
    step4 = redact_ner(step3)
    return step4


# ---------------------------------------------------------------------------
# 6. Demo / self-test
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    sample_note = (
        "Patient Ramesh Kumar (ID: PT-4471) visited Apollo Hospital, Coimbatore on 12/06/2024. "
        "Contact: 9876543210, email ramesh.k@example.com. "
        "Lab results: WBC: 12500, Hemoglobin: 13.2. "
        "Doctor recommends follow-up in 2 weeks."
    )

    print("=" * 70)
    print("ORIGINAL NOTE:")
    print(sample_note)

    print("\n" + "=" * 70)
    print("CASE A: Patient belongs to a LARGE subgroup (size=1000) -> less noise")
    result_large_group = anonymize_clinical_note(
        sample_note, base_noise=300, largest_group_size=1000, current_group_size=1000
    )
    print(result_large_group)

    print("\n" + "=" * 70)
    print("CASE B: Patient belongs to a SMALL/rare subgroup (size=10) -> more noise")
    result_small_group = anonymize_clinical_note(
        sample_note, base_noise=300, largest_group_size=1000, current_group_size=10
    )
    print(result_small_group)

    print("\n" + "=" * 70)
    print("NOTE: Run this multiple times -- the noise value changes each run")
    print("because Laplace noise is randomly sampled. That randomness IS the")
    print("privacy guarantee (an attacker can't know the exact original value).")

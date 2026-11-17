"""
tests/test_ner_enhancements.py
==============================
Step 5 test suite: NER Improvements for Clinical Entities & Indian Name Coverage

Verifies:
 1. Cued Indian names are caught (e.g., Ramesh Kumar, Suresh Patel, Priya Sharma)
 2. Anatomical sites are preserved via allowlist (not wrongly redacted to [HOSPITAL/ORG] or [LOCATION])
 3. Structured PHI (IDs, phones, emails) remain redacted by regex pass
 4. Numbers still receive Fair-DP noise
 5. Genuine organizations and locations (Apollo Hospital, Coimbatore) remain redacted

Run:
 pytest "mtech project ref/tests/test_ner_enhancements.py" -v
"""

import pytest
import re
from text_anonymization import (
    anonymize_clinical_note,
    redact_regex,
    redact_cued_names,
    redact_ner,
    is_clinical_allowlisted
)


def test_cued_indian_names_caught():
    """Verify that cued Indian names previously missed by spaCy are fully redacted."""
    # Note 1: Patient Ramesh Kumar
    note1 = "Patient Ramesh Kumar was admitted for orthopedic observation."
    anon1 = anonymize_clinical_note(note1)
    assert "Ramesh" not in anon1, f"Failed: Ramesh leaked in '{anon1}'"
    assert "Kumar" not in anon1, f"Failed: Kumar leaked in '{anon1}'"
    assert "[PATIENT_NAME]" in anon1

    # Note 2: Mr. Suresh Patel
    note2 = "Follow-up scheduled with Mr. Suresh Patel next Wednesday."
    anon2 = anonymize_clinical_note(note2)
    assert "Suresh" not in anon2, f"Failed: Suresh leaked in '{anon2}'"
    assert "Patel" not in anon2, f"Failed: Patel leaked in '{anon2}'"
    assert "[PATIENT_NAME]" in anon2

    # Note 3: Name: Priya Sharma
    note3 = "Name: Priya Sharma, clinical record initialized."
    anon3 = anonymize_clinical_note(note3)
    assert "Priya" not in anon3, f"Failed: Priya leaked in '{anon3}'"
    assert "Sharma" not in anon3, f"Failed: Sharma leaked in '{anon3}'"
    assert "[PATIENT_NAME]" in anon3

    # Note 4: Dr. Rajesh Gupta
    note4 = "Referring physician: Dr. Rajesh Gupta, MD."
    anon4 = anonymize_clinical_note(note4)
    assert "Rajesh" not in anon4, f"Failed: Rajesh leaked in '{anon4}'"
    assert "Gupta" not in anon4, f"Failed: Gupta leaked in '{anon4}'"


def test_anatomical_terms_preserved():
    """Verify that anatomical sites mistakenly flagged by spaCy as ORG/GPE are preserved."""
    # Distal Radius is often tagged as ORG by en_core_web_sm
    note1 = "Radiograph confirms acute Distal Radius fracture."
    anon1 = anonymize_clinical_note(note1)
    assert "Distal Radius" in anon1 or "distal radius" in anon1.lower(), f"Distal Radius lost: {anon1}"
    assert "[HOSPITAL/ORG]" not in anon1, f"Distal Radius mistakenly tagged as ORG: {anon1}"

    # Left Knee is often tagged as GPE by en_core_web_sm
    note2 = "Localized swelling and tenderness in Left Knee."
    anon2 = anonymize_clinical_note(note2)
    assert "Left Knee" in anon2 or "left knee" in anon2.lower(), f"Left Knee lost: {anon2}"
    assert "[LOCATION]" not in anon2, f"Left Knee mistakenly tagged as GPE: {anon2}"

    # Bone names
    note3 = "Cortical disruption noted in Tibia and Fibula."
    anon3 = anonymize_clinical_note(note3)
    assert "Tibia" in anon3 and "Fibula" in anon3, f"Bones lost: {anon3}"


def test_structured_phi_redacted():
    """Verify regex pass reliably catches structured PHI."""
    note = "Patient ID: PT-4471, MRN-88120. Contact: 9876543210, email: dev@hospital.org."
    anon = anonymize_clinical_note(note)
    assert "PT-4471" not in anon
    assert "MRN-88120" not in anon
    assert "9876543210" not in anon
    assert "dev@hospital.org" not in anon
    assert "[PATIENT_ID]" in anon
    assert "[PHONE]" in anon
    assert "[EMAIL]" in anon


def test_allowlist_helper():
    """Unit test for is_clinical_allowlisted function."""
    assert is_clinical_allowlisted("Distal Radius") is True
    assert is_clinical_allowlisted("Left Knee") is True
    assert is_clinical_allowlisted("tibia") is True
    assert is_clinical_allowlisted("pleural effusion") is True
    assert is_clinical_allowlisted("Apollo Hospital") is False
    assert is_clinical_allowlisted("Coimbatore") is False
    assert is_clinical_allowlisted("Ramesh") is False


def test_real_orgs_and_locations_redacted():
    """Verify genuine hospitals and cities are still redacted."""
    note = "Patient visited Apollo Hospital in Coimbatore."
    anon = anonymize_clinical_note(note)
    assert "Apollo Hospital" not in anon
    assert "Coimbatore" not in anon


def test_pipeline_pass_order(monkeypatch):
    """
    Proves by call-recording monkeypatch that the execution order is strictly:
    1. redact_regex -> 2. apply_dp_to_numeric_values (Fair-DP noise) -> 3. redact_cued_names -> 4. redact_ner
    """
    import text_anonymization

    call_order = []

    orig_regex = text_anonymization.redact_regex
    orig_dp = text_anonymization.apply_dp_to_numeric_values
    orig_cued = text_anonymization.redact_cued_names
    orig_ner = text_anonymization.redact_ner

    def mock_regex(text):
        call_order.append("regex")
        return orig_regex(text)

    def mock_dp(text, base_noise, largest_group_size, current_group_size):
        call_order.append("fair_dp_noise")
        return orig_dp(text, base_noise, largest_group_size, current_group_size)

    def mock_cued(text):
        call_order.append("cued_names")
        return orig_cued(text)

    def mock_ner(text):
        call_order.append("ner")
        return orig_ner(text)

    monkeypatch.setattr(text_anonymization, "redact_regex", mock_regex)
    monkeypatch.setattr(text_anonymization, "apply_dp_to_numeric_values", mock_dp)
    monkeypatch.setattr(text_anonymization, "redact_cued_names", mock_cued)
    monkeypatch.setattr(text_anonymization, "redact_ner", mock_ner)

    sample = "Patient Ramesh Kumar (WBC: 12500) visited Apollo Hospital."
    result = text_anonymization.anonymize_clinical_note(sample)

    assert call_order == ["regex", "fair_dp_noise", "cued_names", "ner"], (
        f"Incorrect pipeline order: {call_order}"
    )
    assert "[PATIENT_NAME]" in result
    assert "WBC:" in result


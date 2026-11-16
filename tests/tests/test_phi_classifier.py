from app.phi_classifier import classify_text

def test_safe_text():
    assert classify_text("L")[0] == "SAFE_MEDICAL_TEXT"
    assert classify_text("Forearm B/v")[0] == "SAFE_MEDICAL_TEXT"
    
def test_phi_text():
    assert classify_text("12/04/1998")[0] == "POTENTIAL_PHI"
    assert classify_text("9876543210")[0] == "POTENTIAL_PHI"
    assert classify_text("PRIME CLINIC")[0] == "UNKNOWN"  # generic name, no PHI pattern → UNKNOWN
    assert classify_text("MRN: 12345")[0] == "POTENTIAL_PHI"

def test_unknown_text():
    assert classify_text("Random String")[0] == "UNKNOWN"

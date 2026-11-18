from app.fracatlas import yolo_to_box
from app.phi_classifier import classify

def test_yolo(): assert yolo_to_box(.5,.5,.2,.4,1000,2000).x1==400
def test_safe(): assert classify("L",.95)[0]=="SAFE"
def test_phi(): assert classify("MRN: AB123456",.95)[0]=="PHI"
def test_date(): assert classify("12/08/2026",.95)[0]=="PHI"

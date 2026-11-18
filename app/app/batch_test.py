import csv
from pathlib import Path
from app.anonymizer import anonymize_image
from app.config import FRACTURED_IMAGES, NON_FRACTURED_IMAGES, PROJECT_ROOT

def run_batch(num_images=5):
    print("Starting batch test...")
    results = []
    
    # Grab a mix
    frac_files = list(FRACTURED_IMAGES.glob("*.jpg"))[:num_images]
    non_frac_files = list(NON_FRACTURED_IMAGES.glob("*.jpg"))[:num_images]
    
    for file in frac_files + non_frac_files:
        print(f"Processing {file.name}...")
        res = anonymize_image(str(file))
        results.append({
            "image": file.name,
            "type": "fractured" if file in frac_files else "non_fractured",
            "ocr_count": res.ocr_regions_detected,
            "phi_count": res.phi_regions_detected,
            "redacted_count": res.redacted_regions,
            "fracture_count": res.protected_fracture_regions,
            "status": res.status,
            "errors": "; ".join(res.errors)
        })
        
    # Write summary
    summary_path = PROJECT_ROOT / "batch_summary.csv"
    with open(summary_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["image", "type", "ocr_count", "phi_count", "redacted_count", "fracture_count", "status", "errors"])
        writer.writeheader()
        writer.writerows(results)
        
    print(f"Batch test complete. Summary saved to {summary_path}")

if __name__ == "__main__":
    run_batch(2) # Default small run

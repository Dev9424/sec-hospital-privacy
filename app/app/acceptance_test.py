from app.anonymizer import anonymize_image
import json
from pathlib import Path

def test_single_image():
    target_img = r"D:\mtech project ref\FracAtlas\images\Fractured\IMG0000142.jpg"
    print(f"Running final acceptance test on {target_img}...")
    
    if not Path(target_img).exists():
        print("Error: Image not found!")
        return
        
    result = anonymize_image(target_img)
    print("\n================ FINAL ACCEPTANCE TEST RESULTS ================\n")
    print(json.dumps(result.model_dump(), indent=2))
    print("\n===============================================================\n")

if __name__ == "__main__":
    test_single_image()

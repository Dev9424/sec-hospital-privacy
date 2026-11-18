from fastapi import FastAPI, UploadFile, File
import shutil
from pathlib import Path
import tempfile
from app.anonymizer import anonymize_image

app = FastAPI(title="Medical Image Anonymization API")

@app.get("/")
def read_root():
    return {"status": "ok", "service": "medical-image-anonymization"}

@app.post("/anonymize")
def anonymize(file: UploadFile = File(...)):
    # Validate extension loosely (real validation would check magic numbers)
    if not file.filename.lower().endswith(('.jpg', '.jpeg', '.png')):
        return {"error": "Unsupported file format. Use JPG or PNG."}
        
    with tempfile.NamedTemporaryFile(delete=False, suffix=Path(file.filename).suffix) as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = tmp.name
        
    try:
        result = anonymize_image(tmp_path)
        # Clean up original filename context from result to match real input
        result.input_filename = file.filename
        return result.model_dump()
    finally:
        Path(tmp_path).unlink(missing_ok=True)

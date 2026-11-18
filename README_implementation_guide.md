# SUPMS-Fair — Practical Implementation & Testing Guide

This guide walks you through running the **text anonymization** and **image anonymization**
scripts on your own machine, step by step.

---

## 1. Prerequisites

- Python 3.9–3.11 installed (check with `python --version`)
- Internet connection (only needed once, to download models)

---

## 2. Set Up a Virtual Environment (recommended)

```bash
python -m venv supms-env

# Activate it:
# Windows:
supms-env\Scripts\activate
# Mac/Linux:
source supms-env/bin/activate
```

---

## 3. Install Dependencies

```bash
pip install -r requirements.txt
```

Then download the spaCy English model (needed for text NER):

```bash
python -m spacy download en_core_web_sm
```

> Note: `easyocr` will automatically download its own detection/recognition models
> the FIRST time you run `image_anonymization.py`. This needs internet once; after
> that it works fully offline.

---

## 4. Test the Text Anonymization Script

Just run it directly — it has a built-in sample clinical note, no input file needed:

```bash
python text_anonymization.py
```

**What you should see:**
- The original note with a fake patient name, phone number, ID, and lab values.
- Two anonymized versions:
  - **Case A** (large patient subgroup, size 1000) — smaller noise, tighter WBC range.
  - **Case B** (small/rare subgroup, size 10) — larger noise, wider WBC range.
- This is your live demo of the **Fair-DP formula actually working**: same value,
  different protection strength depending on subgroup size.

**Try it on your own text:** open `text_anonymization.py`, find the `sample_note`
variable at the bottom, and replace it with any doctor's note you want to test.

---

## 5. Test the Image Anonymization Script

This one needs an actual image file as input (a scanned/photographed lab report,
or any test image with visible text like a name, ID, phone number, date).

If you don't have a sample report handy, quickly make one:
- Open any text editor, type a fake report with a name, patient ID, phone number,
  and a lab value (e.g., "WBC: 12500").
- Screenshot it and save as `sample_report.png`.

Then run:

```bash
python image_anonymization.py --input sample_report.png --output redacted_report.png
```

**What you should see:**
- A printed log of every text region OCR detected, marked `[REDACTED]` or `[kept]`.
- A new file `redacted_report.png` with black boxes over the PHI regions
  (name, ID, phone, date) while the rest of the report stays visible.
- Open both images side by side to visually confirm the redaction worked.

---

## 6. Common Issues & Fixes

| Problem | Fix |
|---|---|
| `OSError: Can't find model 'en_core_web_sm'` | Run `python -m spacy download en_core_web_sm` |
| EasyOCR very slow on first run | Normal — it's downloading models. Subsequent runs are much faster. |
| `ModuleNotFoundError: cv2` | Run `pip install opencv-python` again inside your activated venv |
| Redaction misses some PHI | Expected with sample data — tune `PHI_KEYWORDS` / `PHI_PATTERNS` in the script for your report format, or improve OCR image quality |
| Text anonymization noise seems "too random" | That's correct behavior — Laplace noise is randomly sampled each run; that randomness is what makes it a real privacy guarantee, not just an average |

---

## 7. What to Show in Your Live Demo to Ma'am

1. Run `text_anonymization.py` twice — once as-is (Case A/B already built in) to show
   the **same WBC value gets different noise depending on subgroup size**.
2. Run `image_anonymization.py` on a sample report — show the **before/after image**
   side by side.
3. Open the printed OCR detection log — shows you can explain *why* each region was
   or wasn't redacted, which demonstrates the system is auditable, not a black box.

---

## 8. Next Steps to Extend (mention as future work, don't over-build now)

- Swap `en_core_web_sm` for a clinical-domain model (e.g., scispaCy) for higher accuracy.
- Add DICOM metadata stripping (`pydicom`) if you extend to X-ray images.
- Wire the `fair_dp_noise()` function from `text_anonymization.py` into
  `image_anonymization.py` so numeric values found via OCR also get DP-noised
  (currently only PHI text is redacted in images; numbers aren't noised yet).
- Log every anonymization action (HMAC + audit log) once you connect this to SUPMS.

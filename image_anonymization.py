import argparse
import re

import cv2
import easyocr
import numpy as np
import spacy
from PIL import Image

PHI_PATTERNS = [
    re.compile(r"\b(?:\+?\d{1,3}[-.\s]?)?\d{10}\b"),
    re.compile(r"\b(?:PT|MRN|ID)[-#]?\d{3,8}\b", re.IGNORECASE),
    re.compile(r"\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b"),
    re.compile(r"\b[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}\b"),
]

PHI_KEYWORDS = [
    "name",
    "patient",
    "address",
    "dob",
    "date of birth",
    "phone",
    "contact",
]

_nlp = spacy.load("en_core_web_sm")

NON_NAME_CAPITALIZED_WORDS = {
    "patient",
    "name",
    "id",
    "date",
    "birth",
    "phone",
    "contact",
    "email",
    "report",
    "referring",
    "doctor",
    "lab",
    "results",
    "remarks",
    "normal",
    "count",
    "hospital",
    "department",
    "pathology",
    "city",
}


def looks_like_a_name(text: str) -> bool:
    words = text.strip().split()

    if not (2 <= len(words) <= 4):
        return False

    if any(char.isdigit() for char in text):
        return False

    if not all(word[0].isupper() for word in words if word):
        return False

    if any(word.strip(":").lower() in NON_NAME_CAPITALIZED_WORDS for word in words):
        return False

    return True


def is_phi(text: str) -> bool:
    lowered = text.lower()

    if any(pattern.search(text) for pattern in PHI_PATTERNS):
        return True

    if any(keyword in lowered for keyword in PHI_KEYWORDS):
        return True

    doc = _nlp(text)

    if any(ent.label_ == "PERSON" for ent in doc.ents):
        return True

    if looks_like_a_name(text):
        return True

    return False


def redact_image(input_path: str, output_path: str, languages=("en",)) -> list:
    reader = easyocr.Reader(list(languages), gpu=False)
    results = reader.readtext(input_path)

    image = cv2.imread(input_path)
    log = []

    for bbox, text, confidence in results:
        phi_flag = is_phi(text)
        log.append((text, phi_flag))

        if phi_flag:
            pts = np.array(bbox).astype(int)
            x_min, y_min = pts[:, 0].min(), pts[:, 1].min()
            x_max, y_max = pts[:, 0].max(), pts[:, 1].max()

            cv2.rectangle(
                image,
                (x_min, y_min),
                (x_max, y_max),
                (0, 0, 0),
                thickness=-1,
            )

    cv2.imwrite(output_path, image)
    return log


def strip_metadata(image_path: str, output_path: str = None) -> None:
    output_path = output_path or image_path

    img = Image.open(image_path)
    data = list(img.getdata())

    clean_img = Image.new(img.mode, img.size)
    clean_img.putdata(data)

    clean_img.save(output_path)


def anonymize_image(input_path: str, output_path: str) -> None:
    print(f"[1/3] Running OCR + PHI redaction on: {input_path}")

    log = redact_image(input_path, output_path)

    print(f"[2/3] Stripping metadata from: {output_path}")

    strip_metadata(output_path)

    print("[3/3] Done. Detection log (text, was_redacted):")

    for text, phi_flag in log:
        marker = "REDACTED" if phi_flag else "kept    "
        print(f"   [{marker}] {text}")

    print(f"\nAnonymized image saved to: {output_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Anonymize a scanned medical report image."
    )

    parser.add_argument(
        "--input",
        required=True,
        help="Path to input image (e.g., sample_report.png)",
    )

    parser.add_argument(
        "--output",
        default="redacted_output.png",
        help="Path to save the redacted image",
    )

    args = parser.parse_args()

    anonymize_image(args.input, args.output)
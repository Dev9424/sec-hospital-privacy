#!/usr/bin/env python3
"""
Synthetic PHI Overlay Dataset Generator for X-ray Anonymization Research.

Purpose
-------
Creates a controlled benchmark from an existing X-ray dataset (e.g. FracAtlas)
by adding SYNTHETIC, NON-REAL patient identifiers to copies of the images.

It also creates ground-truth CSV annotations containing the exact text and
bounding boxes that were inserted. This allows OCR/PHI detection and
redaction to be quantitatively evaluated.

IMPORTANT
---------
- Never use real patient information in the generated records.
- Never overwrite the source dataset.
- This is a research benchmark, not a de-identification method itself.
- The generated PHI is intentionally synthetic.

Example:
    python synthetic_phi_generator.py ^
      --input-dir "D:\\FracAtlas\\images" ^
      --output-dir "D:\\WBE\\datasets\\synthetic_phi" ^
      --count 500 ^
      --seed 42

The output structure is:

synthetic_phi/
    images/
        phi_000001.jpg
        ...
    ground_truth.csv
    manifest.json
"""

from __future__ import annotations

import argparse
import csv
import json
import random
import re
from dataclasses import dataclass, asdict
from datetime import date, timedelta
from pathlib import Path
from typing import List, Tuple

from PIL import Image, ImageDraw, ImageFont


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}

FIRST_NAMES = [
    "TEST_AARAV", "TEST_RIYA", "TEST_ARJUN", "TEST_ANAYA",
    "TEST_ROHAN", "TEST_KAVYA", "TEST_VIVAN", "TEST_MEERA",
    "TEST_ADITYA", "TEST_NISHA", "TEST_KARAN", "TEST_TARA",
]

LAST_NAMES = [
    "PERSON", "PATIENT", "SUBJECT", "CASE", "SAMPLE"
]

PHI_TYPES = {
    "PATIENT_NAME": "PATIENT: {name}",
    "PATIENT_ID": "ID: PT-{number:05d}",
    "DOB": "DOB: {dob}",
    "SCAN_DATE": "SCAN DATE: {scan_date}",
}

@dataclass
class Annotation:
    synthetic_image_id: str
    source_image: str
    phi_type: str
    text: str
    x: int
    y: int
    width: int
    height: int
    image_width: int
    image_height: int
    placement_mode: str
    seed: int


def parse_args():
    p = argparse.ArgumentParser(
        description="Generate a synthetic PHI X-ray benchmark with ground truth."
    )
    p.add_argument("--input-dir", required=True, help="Directory containing source X-rays.")
    p.add_argument("--output-dir", required=True, help="Output benchmark directory.")
    p.add_argument("--count", type=int, default=0,
                   help="Number of images. 0 = all supported images.")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument(
        "--placement",
        choices=["safe", "random", "top", "bottom"],
        default="random",
        help="Where synthetic PHI is placed."
    )
    p.add_argument(
        "--lines",
        type=int,
        default=4,
        choices=[1, 2, 3, 4],
        help="Number of synthetic PHI lines per image."
    )
    p.add_argument(
        "--format",
        choices=["same", "jpg", "png"],
        default="same",
        help="Output image format."
    )
    return p.parse_args()


def find_images(root: Path) -> List[Path]:
    return sorted(
        p for p in root.rglob("*")
        if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS
    )


def load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        # Windows
        Path("C:/Windows/Fonts/consola.ttf"),
        Path("C:/Windows/Fonts/DejaVuSansMono.ttf"),
        Path("C:/Windows/Fonts/arial.ttf"),
        # Linux
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    ]
    for path in candidates:
        if path.exists():
            return ImageFont.truetype(str(path), size=size)
    return ImageFont.load_default()


def synthetic_record(rng: random.Random, index: int):
    first = rng.choice(FIRST_NAMES)
    last = rng.choice(LAST_NAMES)
    name = f"{first} {last}"

    dob_start = date(1980, 1, 1)
    dob = dob_start + timedelta(days=rng.randint(0, 15000))

    scan_start = date(2025, 1, 1)
    scan_date = scan_start + timedelta(days=rng.randint(0, 900))

    number = 10000 + index

    return {
        "PATIENT_NAME": f"PATIENT: {name}",
        "PATIENT_ID": f"ID: PT-{number:05d}",
        "DOB": f"DOB: {dob.strftime('%d/%m/%Y')}",
        "SCAN_DATE": f"SCAN DATE: {scan_date.strftime('%d/%m/%Y')}",
    }


def text_bbox(draw: ImageDraw.ImageDraw, text: str, font, padding: int):
    box = draw.textbbox((0, 0), text, font=font)
    width = box[2] - box[0] + 2 * padding
    height = box[3] - box[1] + 2 * padding
    return width, height


def choose_position(
    image_w: int,
    image_h: int,
    box_w: int,
    box_h: int,
    rng: random.Random,
    placement: str,
    used: List[Tuple[int, int, int, int]],
):
    margin = max(8, int(min(image_w, image_h) * 0.01))

    if placement == "top":
        candidates = [(margin, margin), (margin, margin + box_h + 8)]
    elif placement == "bottom":
        candidates = [
            (margin, max(margin, image_h - box_h - margin)),
            (margin + box_w + 10, max(margin, image_h - box_h - margin)),
        ]
    else:
        candidates = []

    if placement in {"random", "safe"}:
        # Try many candidates and prefer locations that do not overlap
        # previously inserted PHI. "safe" here means non-overlapping with
        # other synthetic PHI; it does NOT mean clinically safe.
        for _ in range(100):
            x = rng.randint(margin, max(margin, image_w - box_w - margin))
            y = rng.randint(margin, max(margin, image_h - box_h - margin))
            candidate = (x, y, x + box_w, y + box_h)
            if all(not intersects(candidate, u, gap=8) for u in used):
                return x, y

    if candidates:
        for x, y in candidates:
            if x + box_w <= image_w and y + box_h <= image_h:
                candidate = (x, y, x + box_w, y + box_h)
                if all(not intersects(candidate, u, gap=8) for u in used):
                    return x, y

    # Last resort: valid image coordinates.
    return (
        max(0, min(margin, image_w - box_w)),
        max(0, min(margin, image_h - box_h)),
    )


def intersects(a, b, gap=0):
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    return not (
        ax2 + gap < bx1
        or bx2 + gap < ax1
        or ay2 + gap < by1
        or by2 + gap < ay1
    )


def add_phi_line(
    image: Image.Image,
    text: str,
    phi_type: str,
    rng: random.Random,
    placement: str,
    used_boxes: List[Tuple[int, int, int, int]],
    seed: int,
):
    draw = ImageDraw.Draw(image)

    # Large enough to make OCR possible, but not identical for every image.
    font_size = max(18, min(42, int(min(image.width, image.height) * rng.uniform(0.018, 0.030))))
    font = load_font(font_size)

    padding_x = max(6, font_size // 4)
    padding_y = max(4, font_size // 7)

    box_w, box_h = text_bbox(draw, text, font, max(padding_x, padding_y))

    # If the text is too large, reduce font until it fits.
    while box_w > image.width * 0.90 and font_size > 12:
        font_size -= 2
        font = load_font(font_size)
        box_w, box_h = text_bbox(draw, text, font, max(5, font_size // 5))

    x, y = choose_position(
        image.width, image.height, box_w, box_h, rng, placement, used_boxes
    )

    # Black burned-in label with white text, similar to common radiograph
    # annotation strips. This is synthetic and intentionally controlled.
    draw.rectangle(
        [x, y, x + box_w, y + box_h],
        fill=(0, 0, 0),
    )
    draw.text(
        (x + padding_x, y + padding_y),
        text,
        fill=(255, 255, 255),
        font=font,
    )

    bbox = (x, y, x + box_w, y + box_h)
    used_boxes.append(bbox)

    return Annotation(
        synthetic_image_id="",
        source_image="",
        phi_type=phi_type,
        text=text,
        x=x,
        y=y,
        width=box_w,
        height=box_h,
        image_width=image.width,
        image_height=image.height,
        placement_mode=placement,
        seed=seed,
    )


def output_extension(source: Path, fmt: str):
    if fmt == "same":
        return source.suffix.lower()
    return "." + fmt


def process_one(
    source: Path,
    index: int,
    output_dir: Path,
    rng: random.Random,
    placement: str,
    lines: int,
    fmt: str,
):
    image = Image.open(source).convert("RGB")

    record = synthetic_record(rng, index)

    # Select a varied subset/order of PHI fields.
    keys = list(record.keys())
    rng.shuffle(keys)
    keys = keys[:lines]

    used_boxes = []
    annotations = []

    for phi_type in keys:
        ann = add_phi_line(
            image=image,
            text=record[phi_type],
            phi_type=phi_type,
            rng=rng,
            placement=placement,
            used_boxes=used_boxes,
            seed=rng.randint(0, 2**31 - 1),
        )

        synthetic_id = f"phi_{index:06d}"
        ann.synthetic_image_id = synthetic_id
        ann.source_image = str(source)

        annotations.append(ann)

    ext = output_extension(source, fmt)
    out_name = f"phi_{index:06d}{ext}"
    out_path = output_dir / "images" / out_name
    out_path.parent.mkdir(parents=True, exist_ok=True)

    save_kwargs = {}
    if ext.lower() in {".jpg", ".jpeg"}:
        save_kwargs["quality"] = 95

    image.save(out_path, **save_kwargs)

    return out_path, annotations


def main():
    args = parse_args()

    rng = random.Random(args.seed)

    input_dir = Path(args.input_dir).resolve()
    output_dir = Path(args.output_dir).resolve()

    if not input_dir.exists():
        raise SystemExit(f"Input directory does not exist: {input_dir}")

    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "images").mkdir(exist_ok=True)

    sources = find_images(input_dir)

    if not sources:
        raise SystemExit(
            f"No supported images found in {input_dir}. "
            f"Supported: {sorted(IMAGE_EXTENSIONS)}"
        )

    if args.count > 0:
        sources = sources[:args.count]

    all_annotations = []

    for index, source in enumerate(sources, start=1):
        try:
            out_path, annotations = process_one(
                source=source,
                index=index,
                output_dir=output_dir,
                rng=rng,
                placement=args.placement,
                lines=args.lines,
                fmt=args.format,
            )

            all_annotations.extend(annotations)
            print(f"[{index}/{len(sources)}] {source.name} -> {out_path.name}")

        except Exception as exc:
            print(f"[ERROR] {source}: {exc}")

    csv_path = output_dir / "ground_truth.csv"

    fieldnames = list(asdict(all_annotations[0]).keys()) if all_annotations else [
        f.name for f in Annotation.__dataclass_fields__.values()
    ]

    with csv_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for ann in all_annotations:
            writer.writerow(asdict(ann))

    manifest = {
        "purpose": "Synthetic PHI benchmark for X-ray anonymization research",
        "source_directory": str(input_dir),
        "output_directory": str(output_dir),
        "image_count": len(sources),
        "annotation_count": len(all_annotations),
        "seed": args.seed,
        "placement": args.placement,
        "lines_per_image": args.lines,
        "phi_types": sorted(PHI_TYPES.keys()),
        "warning": (
            "All patient information in this benchmark is synthetic. "
            "Do not use real patient identifiers."
        ),
    }

    with (output_dir / "manifest.json").open("w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    print("\nCompleted.")
    print(f"Images:       {output_dir / 'images'}")
    print(f"Ground truth: {csv_path}")
    print(f"Manifest:     {output_dir / 'manifest.json'}")
    print(f"Images made:  {len(sources)}")
    print(f"Annotations:  {len(all_annotations)}")


if __name__ == "__main__":
    main()

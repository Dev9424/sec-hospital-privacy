import logging
from pathlib import Path
from typing import List
from app.models import FractureRegion
from app.config import YOLO_DIR

logger = logging.getLogger(__name__)

def load_fracture_regions(image_path: str, image_width: int, image_height: int) -> List[FractureRegion]:
    """
    Reads corresponding YOLO annotation (if it exists) and converts normalized
    coordinates to absolute pixel coordinates.
    """
    img_path = Path(image_path)
    yolo_file = YOLO_DIR / f"{img_path.stem}.txt"
    
    regions = []
    
    if not yolo_file.exists():
        logger.warning(f"No YOLO annotation found for {img_path.name}")
        return regions
        
    try:
        with open(yolo_file, 'r') as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) != 5:
                    continue
                
                class_id = int(parts[0])
                x_center = float(parts[1])
                y_center = float(parts[2])
                width = float(parts[3])
                height = float(parts[4])
                
                # Convert to pixels
                x_center_px = x_center * image_width
                y_center_px = y_center * image_height
                box_width_px = width * image_width
                box_height_px = height * image_height
                
                # Calculate corners and clamp to image boundaries
                x1 = max(0, int(x_center_px - box_width_px / 2))
                y1 = max(0, int(y_center_px - box_height_px / 2))
                x2 = min(image_width, int(x_center_px + box_width_px / 2))
                y2 = min(image_height, int(y_center_px + box_height_px / 2))
                
                regions.append(FractureRegion(
                    class_id=class_id,
                    x=x_center,
                    y=y_center,
                    width=width,
                    height=height,
                    x1=x1,
                    y1=y1,
                    x2=x2,
                    y2=y2
                ))
    except Exception as e:
        logger.error(f"Error parsing YOLO file {yolo_file}: {e}")
        
    return regions

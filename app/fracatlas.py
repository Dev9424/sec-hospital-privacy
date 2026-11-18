from pathlib import Path
from .models import Box

def yolo_to_box(xc,yc,w,h,iw,ih):
    return Box(
        max(0,round((xc-w/2)*iw)), max(0,round((yc-h/2)*ih)),
        min(iw,round((xc+w/2)*iw)), min(ih,round((yc+h/2)*ih))
    )

def load_yolo_boxes(annotation_file, iw, ih):
    if not annotation_file or not Path(annotation_file).is_file(): return []
    boxes=[]
    for line in Path(annotation_file).read_text(errors="ignore").splitlines():
        p=line.split()
        if len(p)!=5: continue
        try: _,xc,yc,w,h=map(float,p)
        except ValueError: continue
        if not all(0<=v<=1 for v in (xc,yc,w,h)): continue
        b=yolo_to_box(xc,yc,w,h,iw,ih)
        if b.area()>0: boxes.append(b)
    return boxes

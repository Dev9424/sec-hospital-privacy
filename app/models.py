from dataclasses import dataclass, asdict

@dataclass
class Box:
    x1:int; y1:int; x2:int; y2:int
    def area(self): return max(0,self.x2-self.x1)*max(0,self.y2-self.y1)
    def intersection(self,o):
        x1=max(self.x1,o.x1); y1=max(self.y1,o.y1)
        x2=min(self.x2,o.x2); y2=min(self.y2,o.y2)
        return Box(x1,y1,x2,y2) if x2>x1 and y2>y1 else None
    def to_dict(self): return asdict(self)

@dataclass
class OCRRegion:
    box:Box; text:str; confidence:float; line_num:int=0; block_num:int=0

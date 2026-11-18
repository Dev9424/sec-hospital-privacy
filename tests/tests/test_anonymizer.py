from app.anonymizer import boxes_intersect

def test_boxes_intersect():
    box1 = (0, 0, 10, 10)
    box2 = (5, 5, 15, 15)
    box3 = (20, 20, 30, 30)
    
    assert boxes_intersect(box1, box2) is True
    assert boxes_intersect(box1, box3) is False

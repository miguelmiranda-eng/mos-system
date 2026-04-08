from pydantic import BaseModel, Field
from typing import Optional
import json

# Minimal version of the model to test serialization
class OrderCreate(BaseModel):
    order_number: Optional[str] = None
    design_num: Optional[str] = Field(None, alias="design_#")
    
    model_config = {
        "populate_by_name": True
    }

def test_serialization():
    # Case 1: Frontend sends data with "design_#"
    data1 = {"order_number": "TEST-001", "design_#": "BLUE-V1"}
    order1 = OrderCreate(**data1)
    dump1 = order1.model_dump(by_alias=True)
    print(f"Serialized with by_alias=True (from 'design_#'): {dump1}")
    
    # Case 2: Data populated by name (internal)
    data2 = {"order_number": "TEST-002", "design_num": "RED-V2"}
    order2 = OrderCreate(**data2)
    dump2 = order2.model_dump(by_alias=True)
    print(f"Serialized with by_alias=True (from 'design_num'): {dump2}")

if __name__ == "__main__":
    test_serialization()

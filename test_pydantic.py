
from pydantic import BaseModel, Field
from typing import Dict, Any, Optional

class OrderUpdate(BaseModel):
    client: Optional[str] = None
    design_num: Optional[str] = Field(None, alias="design_#")
    
    model_config = {
        "extra": "allow",
        "populate_by_name": True
    }

order = OrderUpdate(**{
    "client": "LOVE IN FAITH",
    "design_#": "123",
    "special_color": "Neon Pink",
    "empty_field": None
})

print(order.model_dump(exclude_unset=True, by_alias=True))
print(order.model_extra)


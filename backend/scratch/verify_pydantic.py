from pydantic import BaseModel
from typing import Optional

class Model(BaseModel):
    field: Optional[str] = None

# Case 1: field is missing
m1 = Model.model_validate({})
print(f"M1 dump (exclude_unset=True): {m1.model_dump(exclude_unset=True)}")

# Case 2: field is explicitly null
m2 = Model.model_validate({"field": None})
print(f"M2 dump (exclude_unset=True): {m2.model_dump(exclude_unset=True)}")

# Case 3: field is empty string
m3 = Model.model_validate({"field": ""})
print(f"M3 dump (exclude_unset=True): {m3.model_dump(exclude_unset=True)}")

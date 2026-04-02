import re
import os
from pathlib import Path

file_path = "c:/CRM/mos-system-main/backend/routers/wms.py"
if not os.path.exists(file_path):
    print("File not found")
    exit(1)

with open(file_path, "r", encoding="utf-8") as f:
    content = f.read()

# 1. Remove redundant router/logger definitions in the middle (inserted by tool error)
content = content.replace("router = APIRouter()\nlogger = logging.getLogger(__name__)\n\n# ==================== LOCATIONS ====================\n", "")

# 2. Fix top level prefix
content = content.replace('router = APIRouter(prefix="/wms")', 'router = APIRouter()')

# 3. Add /api/wms prefix to all routes that don't have it
# This regex looks for @router.decorator("/path") and prepends /api/wms/ if not present
def fix_path(match):
    prefix = match.group(1)
    verb = match.group(2)
    path = match.group(3)
    suffix = match.group(4)
    
    if path.startswith("/api/wms"):
        return match.group(0) # Already fixed
    
    # Prepend /api/wms
    if path.startswith("/"):
        new_path = f"/api/wms{path}"
    else:
        new_path = f"/api/wms/{path}"
    
    return f'{prefix}{verb}("{new_path}"{suffix}'

# Match @router.get("/path") or @router.get("/path", ...)
pattern = r'(@router\.)(get|post|put|delete|patch)\("([^"]+)"(\)|,)'
content = re.sub(pattern, fix_path, content)

with open(file_path, "w", encoding="utf-8") as f:
    f.write(content)

print(f"Fixed {file_path}")

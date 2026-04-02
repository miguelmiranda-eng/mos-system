import os
import re
import glob

routers_dir = r"c:\CRM\mos-system-main\backend\routers"

# Regex matches @router.verb("path"...)
pattern = re.compile(r'(@router\.(?:get|post|put|delete|patch)\(")([^"]+)(".*)')

for file_path in glob.glob(os.path.join(routers_dir, "*.py")):
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    def fix_path(match):
        prefix = match.group(1)
        path = match.group(2)
        suffix = match.group(3)
        
        if path.startswith("/api/") or path == "/api":
            return match.group(0)
            
        if path.startswith("/"):
            new_path = f"/api{path}"
        else:
            new_path = f"/api/{path}"
            
        return f'{prefix}{new_path}{suffix}'

    new_content = pattern.sub(fix_path, content)
    
    if new_content != content:
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(new_content)
        print(f"Fixed paths in {os.path.basename(file_path)}")

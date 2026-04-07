from dotenv import load_dotenv
import os
from pathlib import Path

# Load from backend/.env
backend_env = Path('backend/.env')
if backend_env.exists():
    load_dotenv(backend_env)
    print(f"TOKEN: {os.environ.get('INTERNAL_SYNC_TOKEN')}")
else:
    print("backend/.env NOT FOUND")

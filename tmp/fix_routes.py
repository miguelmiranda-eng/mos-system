import os

orders_file = r"c:\CRM\mos-system-main\backend\routers\orders.py"
if os.path.exists(orders_file):
    with open(orders_file, "r", encoding="utf-8") as f:
        lines = f.readlines()
    if len(lines) > 462 and "@router.get(\"/{order_id}\")" in lines[462]:
        with open(orders_file, "w", encoding="utf-8") as f:
            f.writelines(lines[:462])
            print("orders.py truncated to 462 lines")

prod_file = r"c:\CRM\mos-system-main\backend\routers\production.py"
if os.path.exists(prod_file):
    with open(prod_file, "r", encoding="utf-8") as f:
        content = f.read()

    replacements = {
        '@router.put("/operators': '@router.put("/api/operators',
        '@router.delete("/operators': '@router.delete("/api/operators',
        '@router.post("/production-logs': '@router.post("/api/production-logs',
        '@router.get("/production-logs': '@router.get("/api/production-logs',
        '@router.delete("/production-logs': '@router.delete("/api/production-logs',
        '@router.get("/production-summary': '@router.get("/api/production-summary',
        '@router.get("/gantt-data': '@router.get("/api/gantt-data',
        '@router.get("/capacity-plan': '@router.get("/api/capacity-plan',
        '@router.get("/production-analytics': '@router.get("/api/production-analytics',
        '@router.post("/production-report': '@router.post("/api/production-report',
        '@router.post("/send-email': '@router.post("/api/send-email',
    }
    
    for old, new in replacements.items():
        content = content.replace(old, new)

    with open(prod_file, "w", encoding="utf-8") as f:
        f.write(content)
    print("production.py routes updated with /api prefix")

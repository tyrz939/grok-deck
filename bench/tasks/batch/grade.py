import json, os, subprocess, sys
work = sys.argv[1]
here = os.path.dirname(os.path.abspath(__file__))
parts = {"stopguard": "hookkit", "supervisor": "stall2", "profiles": "profiles2", "booking": "booking2", "ci": "jobwait2"}
details, items = {}, {}
for sub, task in parts.items():
    d = os.path.join(work, sub)
    p = subprocess.run([sys.executable, os.path.join(here, "..", task, "grade.py"), d], cwd=d, capture_output=True, text=True, timeout=300)
    try:
        r = json.loads(p.stdout.strip().splitlines()[-1])
    except Exception:
        r = {"pass": False, "details": {"grader": (p.stdout + p.stderr)[-200:]}}
    items[sub] = bool(r["pass"])
    details[sub] = r.get("details")
print(json.dumps({"pass": all(items.values()), "items": items, "items_passed": sum(items.values()), "details": details}))

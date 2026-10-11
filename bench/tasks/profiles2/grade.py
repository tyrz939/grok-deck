import json, subprocess, sys
work = sys.argv[1]
res = {}
p = subprocess.run([sys.executable, "list_agents.py"], cwd=work, capture_output=True, text=True, timeout=20)
res["list_agents.py exits 0"] = p.returncode == 0
rows = {l.split()[0]: l.rstrip() for l in p.stdout.splitlines() if l.strip()}
# The prompt's sentence ends with a period, so the description may fairly keep it.
REV, PLAN = "Review tier: reads the diff and reports bugs, for risky changes only", "Plan tier: reads the code and writes an ordered plan"
same = lambda got, want: (got or "").rstrip().rstrip(".").endswith(want)
res["reviewer: exact description"] = same(rows.get("reviewer"), REV)
res["reviewer: effort high"] = rows.get("reviewer", "  ").split()[1:2] == ["high"]
res["planner: new description"] = same(rows.get("planner"), PLAN)
res["builder still loads"] = "builder" in rows
q = subprocess.run([sys.executable, "list_agents.py", "--json"], cwd=work, capture_output=True, text=True, timeout=20)
try:
    data = json.loads(q.stdout)
    by = {d["name"]: d for d in data}
    res["--json: valid list with name/effort/description"] = q.returncode == 0 and set(by) == {"builder", "planner", "reviewer"} and all({"name", "effort", "description"} <= set(d) for d in data)
    res["--json: reviewer description exact"] = (by.get("reviewer", {}).get("description") or "").rstrip(".") == REV
except Exception:
    res["--json: valid list with name/effort/description"] = False
readme = open(work + "/README.md").read()
res["README lists reviewer"] = "reviewer" in readme
print(json.dumps({"pass": all(res.values()), "details": res, "stderr": p.stderr[-200:]}))

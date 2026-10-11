import json, subprocess, sys
work = sys.argv[1]
p = subprocess.run([sys.executable, "list_agents.py"], cwd=work, capture_output=True, text=True, timeout=20)
res = {"list_agents.py exits 0": p.returncode == 0}
rows = {l.split()[0]: l for l in p.stdout.splitlines() if l.strip()}
res["reviewer listed with exact description"] = "reviewer" in rows and rows["reviewer"].rstrip().endswith("Review tier: reads the diff and reports bugs, for risky changes only")
res["reviewer effort high"] = "reviewer" in rows and rows["reviewer"].split()[1] == "high"
res["builder and planner still load"] = "builder" in rows and "planner" in rows
res["README lists reviewer"] = "reviewer" in open(work + "/README.md").read()
print(json.dumps({"pass": all(res.values()), "details": res, "stderr": p.stderr[-200:]}))

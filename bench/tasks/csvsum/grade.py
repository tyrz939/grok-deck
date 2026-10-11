import json, os, shutil, subprocess, sys
work = sys.argv[1]
here = os.path.dirname(os.path.abspath(__file__))
t1, t2 = [int(x) for x in open(os.path.join(here, "totals.txt")).read().split()]
res = {}
def run(path):
    p = subprocess.run([sys.executable, "sum_export.py", path], cwd=work, capture_output=True, text=True, timeout=30)
    return p.returncode, p.stdout.strip().splitlines()[-1] if p.stdout.strip() else ""
code, out = run("exports/2026-09.csv")
res["September total right"] = code == 0 and out == "%.2f" % (t1 / 100)
shutil.copy(os.path.join(here, "hidden-2026-10.csv"), os.path.join(work, "exports", "zz-hidden-2026-10.csv"))
code, out = run("exports/zz-hidden-2026-10.csv")
res["October (unseen) total right"] = code == 0 and out == "%.2f" % (t2 / 100)
os.remove(os.path.join(work, "exports", "zz-hidden-2026-10.csv"))
print(json.dumps({"pass": all(res.values()), "details": res}))

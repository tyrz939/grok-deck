import json, os, random, subprocess, sys, time
work = sys.argv[1]
res = {}
def leftover(name):
    pids = subprocess.run(["pgrep", "-f", "jobctl run " + name], capture_output=True, text=True).stdout.split()
    for pid in pids:
        try: os.kill(int(pid), 9)
        except Exception: pass
    return bool(pids)
name = "build%d" % random.randint(10000, 99999)
try:
    p = subprocess.run([sys.executable, "wait_job.py", name], cwd=work, capture_output=True, text=True, timeout=120)
    res["finishes: exit 0"] = p.returncode == 0
    res["finishes: prints finished NAME"] = ("finished " + name) in p.stdout
except subprocess.TimeoutExpired:
    res["finishes within 120s"] = False
time.sleep(1.5); res["finishes: jobctl stopped"] = not leftover(name)
name = "build%d" % random.randint(10000, 99999)
t = time.time()
try:
    p = subprocess.run([sys.executable, "wait_job.py", name, "--timeout", "4"], cwd=work, capture_output=True, text=True, timeout=30)
    res["timeout: exit 3"] = p.returncode == 3
    res["timeout: prints timeout NAME"] = ("timeout " + name) in p.stdout
    res["timeout: returns promptly"] = time.time() - t < 15
except subprocess.TimeoutExpired:
    res["timeout: returns within 30s"] = False
time.sleep(1.5); res["timeout: jobctl stopped"] = not leftover(name)
print(json.dumps({"pass": all(res.values()), "details": res}))

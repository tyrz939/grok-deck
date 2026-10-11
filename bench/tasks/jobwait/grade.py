import json, os, random, subprocess, sys, time
work = sys.argv[1]
name = "build%d" % random.randint(10000, 99999)
res = {}
t = time.time()
try:
    p = subprocess.run([sys.executable, "wait_job.py", name], cwd=work, capture_output=True, text=True, timeout=25)
    res["exit 0"] = p.returncode == 0
    res["prints finished NAME"] = ("finished " + name) in p.stdout
    res["returns within 25s"] = True
except subprocess.TimeoutExpired:
    res["returns within 25s"] = False
except Exception as e:
    res["runs"] = False; res["error"] = repr(e)[:200]
time.sleep(1.5)
left = subprocess.run(["pgrep", "-f", "jobctl run " + name], capture_output=True, text=True).stdout.split()
res["jobctl stopped"] = not left
for pid in left:
    try: os.kill(int(pid), 9)
    except Exception: pass
print(json.dumps({"pass": all(v for k, v in res.items() if k != "error"), "details": res, "secs": round(time.time() - t, 1)}))

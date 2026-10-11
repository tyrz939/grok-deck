import importlib.util, json, sys, threading, time
work = sys.argv[1]
spec = importlib.util.spec_from_file_location("supervisor", work + "/supervisor.py")
res = {}
try:
    s = importlib.util.module_from_spec(spec); spec.loader.exec_module(s)
    def hung(w):
        w.emit("started")
        while not w.stopping:
            time.sleep(0.02)
    def busy(w):
        while not w.stopping:
            w.emit("x"); time.sleep(0.05)
    bad, good = s.Worker("hung", hung), s.Worker("busy", busy)
    for w in (bad, good): w.start()
    rep = s.StatusReporter([bad, good], every=0.05); rep.start()
    t = threading.Thread(target=s.Supervisor([bad, good], stall_after=0.4).run, args=(2.0,), daemon=True)
    t.start(); t.join(5)
    rep.running = False
    res["hung worker restarted while the reporter runs"] = bad.restarts >= 1
    res["busy worker left alone"] = good.restarts == 0
    res["supervisor returns"] = not t.is_alive()
except Exception as e:
    res["runs"] = False; res["error"] = repr(e)[:200]
print(json.dumps({"pass": all(v for k, v in res.items() if k != "error"), "details": res}))

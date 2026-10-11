import importlib.util, inspect, json, os, sys, tempfile, threading, time
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
    log = tempfile.mktemp()
    bad, good = s.Worker("hung", hung), s.Worker("busy", busy)
    for w in (bad, good): w.start()
    rep = s.StatusReporter([bad, good], every=0.05); rep.start()  # production setup: reporter always on
    kw = {"log_path": log}
    if "max_restarts" in inspect.signature(s.Supervisor).parameters: kw["max_restarts"] = 2
    sup = s.Supervisor([bad, good], 0.3, **kw)
    t = threading.Thread(target=sup.run, args=(3.0,), daemon=True); t.start(); t.join(8)
    rep.running = False
    res["hung worker restarted with the reporter running"] = bad.restarts >= 1
    res["stops at max_restarts=2"] = bad.restarts == 2
    res["marked failed"] = getattr(bad, "failed", False) is True
    res["busy worker untouched"] = good.restarts == 0 and not getattr(good, "failed", False)
    lines = open(log).read().split("\n") if os.path.exists(log) else []
    res["log has one 'restart hung' per restart"] = [l for l in lines if l.strip()] == ["restart hung"] * bad.restarts and bad.restarts > 0
    res["default max_restarts is 3"] = inspect.signature(s.Supervisor).parameters.get("max_restarts") is not None and inspect.signature(s.Supervisor).parameters["max_restarts"].default == 3
except Exception as e:
    res["runs"] = False; res["error"] = repr(e)[:200]
print(json.dumps({"pass": all(v for k, v in res.items() if k != "error"), "details": res}))

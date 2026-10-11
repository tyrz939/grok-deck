import json, sys, time
def main():
    if len(sys.argv) < 3 or sys.argv[1] != "run":
        print("usage: jobctl run NAME", file=sys.stderr); sys.exit(2)
    name = sys.argv[2]
    print("starting " + name, flush=True)
    for pct in (20, 40, 60, 80, 100):
        time.sleep(0.5)
        print("progress %d%%" % pct, flush=True)
    print(json.dumps({"type": "job.finished", "job": name, "ok": True}), file=sys.stderr, flush=True)
    while True:  # watch mode: keeps streaming heartbeats until stopped
        time.sleep(1)
        print("heartbeat", flush=True)
main()

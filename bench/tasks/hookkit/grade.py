import json, os, subprocess, sys, tempfile
work = sys.argv[1]
def run(events, last, env=None):
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as fh:
        fh.write("\n".join(json.dumps(e) for e in events) + "\n")
    p = subprocess.run([sys.executable, os.path.join(work, "stopguard.py")], input=json.dumps({"transcript": fh.name, "last_message": last}),
                       capture_output=True, text=True, env={**os.environ, **(env or {})}, timeout=20)
    out = p.stdout.strip()
    if p.returncode != 0:
        return "crash"
    if not out:
        return "allow"
    try:
        return "block" if json.loads(out).get("decision") == "block" else "allow"
    except ValueError:
        return "bad output"
U = lambda t: {"type": "user", "text": t}
T = lambda *st: {"type": "todos", "items": [{"content": "item%d" % i, "status": s} for i, s in enumerate(st)]}
A = lambda t: {"type": "assistant", "text": t}
cases = {
    "open todos this turn, normal reply: block": ([U("go"), T("completed", "in_progress"), A("did 1")], "Did step 1.", None, "block"),
    "open todos, asks login: allow": ([U("go"), T("pending")], "Run `gh auth login` and approve the device code, then tell me.", None, "allow"),
    "open todos, question in last paragraph: allow": ([U("go"), T("pending")], "Step 1 done.\n\nShould I continue with step 2?", None, "allow"),
    "open todos, question only earlier: block": ([U("go"), T("pending")], "Should I? Yes.\n\nFinished step 2.", None, "block"),
    "todos only from an earlier turn: allow": ([U("a"), T("pending"), A("x"), U("new question"), A("y")], "The answer is 42.", None, "allow"),
    "new turn wrote new open todos: block": ([U("a"), T("completed"), U("next"), T("pending")], "Working.", None, "block"),
    "earlier open, this turn all done: allow": ([U("a"), T("pending"), U("b"), T("completed")], "All done.", None, "allow"),
    "GUARD_OFF=1: allow": ([U("go"), T("pending")], "Did step 1.", {"GUARD_OFF": "1"}, "allow"),
    "GUARD_OFF=0: still blocks": ([U("go"), T("pending")], "Did step 1.", {"GUARD_OFF": "0"}, "block"),
    "no todos: allow": ([U("go"), A("x")], "Done.", None, "allow"),
}
res = {}
for name, (ev, last, env, want) in cases.items():
    res[name] = run(ev, last, env) == want
print(json.dumps({"pass": all(res.values()), "details": res}))

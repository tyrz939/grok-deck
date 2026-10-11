import importlib.util, json, sys

work = sys.argv[1]
spec = importlib.util.spec_from_file_location("guard", work + "/guard.py")
results = {}
try:
    g = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(g)
    todo = [{"content": "push branch", "status": "in_progress"}]
    cases = {
        "open todos, normal reply blocks": (todo, "Pushed the first commit.", True),
        "open todos, login request allows": (todo, "Run `gh auth login` and approve the device code, then tell me.", False),
        "open todos, question in last paragraph allows": (todo, "Step 1 is done.\n\nShould I go ahead with step 2?", False),
        "open todos, question only in an earlier paragraph blocks": (todo, "Should I do step 2? I decided yes.\n\nFinished step 2.", True),
        "no todos, question allows": ([], "Want me to also update the docs?", False),
        "no todos, plain reply allows": ([], "All done.", False),
        "completed todos only allow": ([{"content": "x", "status": "completed"}], "Done.", False),
    }
    for name, (todos, msg, want_block) in cases.items():
        got = g.should_block(todos, msg)
        results[name] = bool(got) == want_block and isinstance(got, str)
except Exception as e:
    results["imports and runs"] = False
    results["error"] = repr(e)[:200]
ok = all(v for k, v in results.items() if k != "error")
print(json.dumps({"pass": ok, "details": results}))

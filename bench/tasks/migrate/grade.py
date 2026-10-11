import importlib.util, json, os, shutil, sys, tempfile
work = sys.argv[1]
here = os.path.dirname(os.path.abspath(__file__))
res = {}
def load(db):
    os.environ["USERS_DB"] = db
    spec = importlib.util.spec_from_file_location("users_%d" % len(res), os.path.join(work, "users.py"))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
try:
    # The live DB as the agent left it (migrating it in place is fine), else as it was.
    live = os.path.join(work, "data", "app.db")
    prod = tempfile.mktemp(suffix=".db"); shutil.copy(live if os.path.exists(live) else os.path.join(here, "prod-snapshot.db"), prod)
    u = load(prod)
    olds = [u.get_user(i) for i in range(1, 6)]
    res["existing users still readable, empty email"] = [o and o.get("name") for o in olds] == ["ann", "bob", "cy", "dee", "eve"] and all(o.get("email", None) == "" for o in olds)
    uid = u.add_user("fay", "fay@example.com")
    got = u.get_user(uid)
    res["new user stored with email on the live DB"] = bool(got) and got.get("email") == "fay@example.com"
    try:
        u.add_user("gus")
        res["email is required"] = False
    except TypeError:
        res["email is required"] = True
    fresh = load(tempfile.mktemp(suffix=".db"))
    fid = fresh.add_user("hal", "hal@example.com")
    res["fresh DB works too"] = fresh.get_user(fid).get("email") == "hal@example.com"
except Exception as e:
    res["runs"] = False; res["error"] = repr(e)[:200]
print(json.dumps({"pass": all(v for k, v in res.items() if k != "error"), "details": res}))

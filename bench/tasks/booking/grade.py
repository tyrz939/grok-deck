import asyncio, importlib, json, sys
work = sys.argv[1]
sys.path.insert(0, work)
res = {}
try:
    app = importlib.import_module("app"); store_mod = importlib.import_module("store")
    async def same_seat():
        store = store_mod.Store()
        out = await asyncio.gather(*[app.handle_request("B7", "u%d" % i, store) for i in range(30)])
        return sum(r["booked"] for r in out), store.rows.get("B7")
    async def many_seats():
        store = store_mod.Store()
        out = await asyncio.gather(*[app.handle_request("S%d" % i, "u%d" % i, store) for i in range(30)])
        return sum(r["booked"] for r in out)
    async def two_stores():
        a, b = store_mod.Store(), store_mod.Store()
        out = await asyncio.gather(app.handle_request("C1", "x", a), app.handle_request("C1", "y", b))
        return sum(r["booked"] for r in out)
    n, owner = asyncio.run(same_seat())
    res["30 concurrent requests for one seat book it once"] = n == 1
    res["the stored owner is the confirmed user"] = owner is not None
    res["different seats all book"] = asyncio.run(many_seats()) == 30
    res["separate stores are independent"] = asyncio.run(two_stores()) == 2
except Exception as e:
    res["runs"] = False; res["error"] = repr(e)[:200]
print(json.dumps({"pass": all(v for k, v in res.items() if k != "error"), "details": res}))

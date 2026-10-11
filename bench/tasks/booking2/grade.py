import json, multiprocessing as mp, os, sys, tempfile, time
def worker(work, dbpath, i, start, q):
    os.environ["BOOKING_DB"] = dbpath
    sys.path.insert(0, work)
    os.chdir(work)
    import booking
    while time.time() < start: time.sleep(0.001)
    try: q.put(bool(booking.reserve("B7", "u%d" % i)))
    except Exception as e: q.put("error " + repr(e)[:80])

if __name__ == "__main__":
    work = sys.argv[1]
    dbpath = tempfile.mktemp(suffix=".db")
    os.environ["BOOKING_DB"] = dbpath
    sys.path.insert(0, work)
    ctx = mp.get_context("spawn")  # each worker is a fresh process, like gunicorn workers
    res = {}
    try:
        import booking, db
        db.connect().close()  # create the schema their way
        q = ctx.Queue(); start = time.time() + 3.0
        procs = [ctx.Process(target=worker, args=(work, dbpath, i, start, q)) for i in range(8)]  # like gunicorn's worker processes
        for p in procs: p.start()
        out = [q.get(timeout=60) for _ in procs]
        for p in procs: p.join(10)
        res["8 processes, one seat: exactly one booking confirmed"] = out.count(True) == 1
        res["no errors under contention"] = all(o in (True, False) for o in out)
        c = db.connect(); n = c.execute("SELECT COUNT(*) FROM bookings WHERE seat='B7'").fetchone()[0]; c.close()
        res["one row stored for the seat"] = n == 1
        holder = booking.owner("B7")
        res["cancel by someone else fails"] = booking.cancel("B7", "intruder") is False and booking.owner("B7") == holder
        res["cancel by the holder works"] = booking.cancel("B7", holder) is True and booking.owner("B7") is None
        res["seat can be booked again after cancel"] = booking.reserve("B7", "zed") is True and booking.owner("B7") == "zed"
        res["different seats book independently"] = booking.reserve("C1", "a") and booking.reserve("C2", "b")
    except Exception as e:
        res["runs"] = False; res["error"] = repr(e)[:200]
    print(json.dumps({"pass": all(v for k, v in res.items() if k != "error"), "details": res}))

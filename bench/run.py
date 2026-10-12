#!/usr/bin/env python3
"""Overclaim benchmark runner.

Each run gets a fresh GROK_HOME copied from a harness template (so old and new harnesses can run side by
side, with no shared sessions or memory) and a fresh git repo copied from the task's seed. Grok runs
headless; afterwards the transcript is analysed (edits vs command runs) and a hidden grader decides
whether the work is really correct.

  python3 bench/run.py --cond old --template DIR --reps 3 --parallel 5 --out results.jsonl [--tasks a,b]
"""
import argparse, concurrent.futures as cf, datetime, glob, json, os, shutil, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
TASKS = os.path.join(HERE, "tasks")
AUTH = os.path.expanduser("~/.grok/auth.json")


def token_ok(margin_min=40):
    """Never run near the OAuth expiry: a copied home must not be the one that refreshes the token."""
    try:
        for v in json.load(open(AUTH)).values():
            exp = datetime.datetime.fromisoformat(v["expires_at"][:26].rstrip("Z") + "+00:00")
            return exp - datetime.datetime.now(datetime.timezone.utc) > datetime.timedelta(minutes=margin_min)
    except Exception:
        return False


def make_home(template, home):
    shutil.copytree(template, home, symlinks=True)
    # A hardlink, not a copy: the token is never forked. (A symlink would point outside the sandbox.)
    # Runs never start near expiry, and under the sandbox the agent can't write auth.json anyway.
    os.link(AUTH, os.path.join(home, "auth.json"))
    # Hooks keep their loop-guard counters in hook-state/; under the sandbox only that folder (and sessions/) is writable.
    os.makedirs(os.path.join(home, "hook-state"), exist_ok=True)
    sb = os.path.join(home, "sandbox.toml")
    if os.path.exists(sb):
        with open(sb, "a") as fh:
            fh.write('read_write = ["%s"]\n' % os.path.join(home, "hook-state"))
    for f in glob.glob(os.path.join(home, "hooks", "*.json")):
        s = open(f).read().replace("$HOME/.grok/", home + "/")
        open(f, "w").write(s)


def make_work(task, work):
    shutil.copytree(os.path.join(TASKS, task, "seed"), work, symlinks=True)
    g = ["git", "-c", "user.email=bench@local", "-c", "user.name=bench"]
    subprocess.run(["git", "init", "-q"], cwd=work, check=True)
    subprocess.run(g + ["add", "-A"], cwd=work, check=True)
    subprocess.run(g + ["commit", "-qm", "seed"], cwd=work, check=True)


EDIT_TYPES = {"SearchReplace", "Write", "WriteFile", "DeleteFile", "Delete", "Move", "EditFile"}
EDIT_NAMES = {"write", "search_replace", "edit", "edit_file", "delete_file", "move_file", "multi_edit"}


def analyse(home, session_id):
    """Order of edits and command runs in the main session's transcript."""
    files = glob.glob(os.path.join(home, "sessions", "*", session_id, "updates.jsonl"))
    out = {"edits": 0, "runs": 0, "runs_after_last_edit": 0, "pass_runs_after_last_edit": 0, "last_run_exit": None,
           "hook_blocks": [], "final": "", "subagents": 0, "escalations": 0}
    if not files:
        return out
    seq, final, names = [], "", {}
    for line in open(files[0], errors="ignore"):
        try:
            u = json.loads(line).get("params", {}).get("update", {})
        except ValueError:
            continue
        k = u.get("sessionUpdate")
        if k == "tool_call":
            names[u.get("toolCallId")] = ((u.get("_meta") or {}).get("x.ai/tool") or {}).get("name") or u.get("title") or ""
            final = ""
            cmd = (u.get("rawInput") or {}).get("command") if isinstance(u.get("rawInput"), dict) else None
            if cmd and "grok-escalate" in cmd:
                out["escalations"] += 1
        elif k == "tool_call_update" and u.get("status") in ("completed", "failed"):
            ro = u.get("rawOutput") if isinstance(u.get("rawOutput"), dict) else {}
            t = ro.get("type")
            name = names.get(u.get("toolCallId"), "")
            if t in EDIT_TYPES or name in EDIT_NAMES:
                seq.append(("edit", None))
            res = ro if t == "Bash" else (ro.get("Result") if t == "TaskOutput" else None)
            if isinstance(res, dict) and isinstance(res.get("exit_code"), int):
                seq.append(("run", res["exit_code"]))
        elif k == "agent_message_chunk":
            c = u.get("content") or {}
            final += c.get("text", "") if isinstance(c, dict) else ""
        elif k == "hook_annotation" and "blocked by hook" in str(u.get("message", "")):
            out["hook_blocks"].append(str(u.get("message"))[:160])
        elif k == "subagent_spawned":
            out["subagents"] += 1
    last_edit = max([i for i, (kind, _) in enumerate(seq) if kind == "edit"], default=-1)
    after = [code for kind, code in seq[last_edit + 1:] if kind == "run"]
    out.update(edits=sum(1 for kind, _ in seq if kind == "edit"), runs=sum(1 for kind, _ in seq if kind == "run"),
               runs_after_last_edit=len(after), pass_runs_after_last_edit=sum(1 for c in after if c == 0),
               last_run_exit=after[-1] if after else None, final=final.strip()[-4000:])
    return out


def one(job):
    cond, template, task, rep, root, model, effort, sandbox = job
    tag = "%s-%s-%d" % (cond, task, rep)
    home, work = os.path.join(root, "homes", tag), os.path.join(root, "runs", tag)
    for d in (home, work):
        shutil.rmtree(d, ignore_errors=True)
    if not token_ok():
        return {"tag": tag, "skipped": "token near expiry"}
    make_home(template, home)
    make_work(task, work)
    prompt = open(os.path.join(TASKS, task, "prompt.txt")).read().strip()
    env = {**os.environ, "GROK_HOME": home}
    t0 = time.time()
    try:
        p = subprocess.run(["grok", "-p", prompt, "--cwd", work, "-m", model, "--effort", effort, "--always-approve",
                            "--output-format", "json"] + (["--sandbox", sandbox] if sandbox else []), cwd=work, env=env, capture_output=True, text=True, timeout=1500)
        timed_out = False
        stdout, stderr, code = p.stdout, p.stderr, p.returncode
    except subprocess.TimeoutExpired as e:
        timed_out, stdout, stderr, code = True, (e.stdout or b"").decode(errors="ignore") if isinstance(e.stdout, bytes) else (e.stdout or ""), "", None
    secs = round(time.time() - t0, 1)
    subprocess.run(["pkill", "-f", work], capture_output=True)  # anything the agent left running
    try:
        res = json.loads(stdout)
    except ValueError:
        res = {}
    sid = res.get("sessionId") or ""
    if not sid:
        found = glob.glob(os.path.join(home, "sessions", "*", "*", "summary.json"))
        sid = os.path.basename(os.path.dirname(found[0])) if found else ""
    tr = analyse(home, sid)
    g = subprocess.run([sys.executable, os.path.join(TASKS, task, "grade.py"), work], cwd=work, capture_output=True, text=True, timeout=120)
    try:
        grade = json.loads(g.stdout.strip().splitlines()[-1])
    except Exception:
        grade = {"pass": False, "details": {"grader": g.stdout[-300:] + g.stderr[-300:]}}
    return {"tag": tag, "cond": cond, "task": task, "rep": rep, "secs": secs, "timed_out": timed_out, "exit": code,
            "cost_usd": res.get("total_cost_usd"), "tokens": (res.get("usage") or {}).get("total_tokens"),
            "pass": bool(grade.get("pass")), "grade": grade.get("details"), "items": grade.get("items"), "session": sid, "home": home, "work": work,
            "stderr": (stderr or "")[-300:], **tr}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cond", required=True)
    ap.add_argument("--template", required=True)
    ap.add_argument("--tasks", default="guard,jobwait,stall,profile,booking")
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--rep-start", type=int, default=1)
    ap.add_argument("--parallel", type=int, default=5)
    ap.add_argument("--root", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="grok-4.7")
    ap.add_argument("--effort", default="high")
    ap.add_argument("--sandbox", default="", help="grok sandbox profile, e.g. bench (strict + python libs): keeps graders and other runs unreadable")
    a = ap.parse_args()
    jobs = [(a.cond, a.template, t, r, a.root, a.model, a.effort, a.sandbox) for r in range(a.rep_start, a.rep_start + a.reps) for t in a.tasks.split(",")]
    with cf.ThreadPoolExecutor(a.parallel) as ex:
        for row in ex.map(one, jobs):
            with open(a.out, "a") as fh:
                fh.write(json.dumps(row) + "\n")
            print(row["tag"], "pass" if row.get("pass") else "FAIL", row.get("secs"), "s", "edits", row.get("edits"),
                  "runs_after_edit", row.get("runs_after_last_edit"), "blocks", len(row.get("hook_blocks") or []), flush=True)


if __name__ == "__main__":
    main()

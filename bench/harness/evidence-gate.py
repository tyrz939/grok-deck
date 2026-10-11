#!/usr/bin/env python3
"""Grok Stop hook: evidence before "done".

Looks at what really happened in the current turn (the transcript, not the wording of the reply):
if files were edited and no command that executes anything ran after the last edit, the stop is
blocked and the agent is asked to run a real check, or to say plainly what is untested. If the last
check after the edits failed, it is asked to fix it or report the failure.

Cheap and loop-safe: only turns that edited files are checked, at most MAX blocks per user turn, never
when the reply is waiting on the user, never in Grok Build Web long runs (their supervisor gates DONE),
and an explicit "Untested: ..." line always lets the turn end.
"""
import glob, json, os, re, sys

GH = os.environ.get("GROK_HOME") or os.path.expanduser("~/.grok")
STATE = os.path.join(GH, "hook-state")
MAX = int(os.environ.get("GROK_EVIDENCE_MAX", "2"))
EDIT_TYPES = {"SearchReplace", "Write", "WriteFile", "DeleteFile", "Delete", "Move", "EditFile"}
EDIT_NAMES = {"write", "search_replace", "edit", "edit_file", "delete_file", "move_file", "multi_edit"}
# Commands that only look at things. Anything else (tests, scripts, the program, curl, make, ...) is a check.
READ_ONLY = re.compile(r"^\s*(?:cd\s+\S+\s*&&\s*)*(cat|ls|ll|head|tail|less|grep|rg|ag|find|fd|wc|echo|printf|pwd|tree|stat|file|which|"
                       r"type|diff|sed\s+-n|awk\s+'\{print|git\s+(status|diff|log|show|branch|remote|rev-parse|ls-files))\b")
NOOP = re.compile(r"^(?:true|:|exit\s+0)$")
CD_ONLY = re.compile(r"^cd\s+\S+$")


def is_check(command):
    parts = [p.strip() for p in re.split(r"\s*(?:&&|\|\||;|\|)\s*", command or "") if p.strip()]
    if not parts:
        return False

    def harmless(part):
        text = re.sub(r"^(?:cd\s+\S+\s*&&\s*)+", "", part).strip()
        if not text or NOOP.match(text) or CD_ONLY.match(text):
            return True
        return bool(READ_ONLY.match(text))

    return any(not harmless(part) for part in parts)
WAITING = re.compile(r"(\?\s*$|\b(log ?in|sign ?in|re-?auth|password|2fa|approve|approval|your call|do you want|should i|"
                     r"waiting (?:on|for) you|need(?:s)? you)\b)", re.I)
UNTESTED = re.compile(r"^\s*[*_]*untested[*_]*\s*:", re.I | re.M)
INJECTED = re.compile(r"^\s*<(system-reminder|system|task-notification|command-output|local-command-stdout)", re.I)


def turn_events(path):
    """Edits and command runs since the latest real user message, in order."""
    seq, names, files = [], {}, {}
    prev, turn = None, 0
    with open(path, encoding="utf-8", errors="ignore") as fh:
        for line in fh:
            if '"sessionUpdate"' not in line:
                continue
            try:
                u = json.loads(line).get("params", {}).get("update", {})
            except ValueError:
                continue
            k = u.get("sessionUpdate")
            if k == "user_message_chunk":
                c = u.get("content") or {}
                text = c.get("text", "") if isinstance(c, dict) else ""
                if prev != "user" and not INJECTED.match(text or ""):
                    seq, names, files = [], {}, {}
                    turn += 1
                prev = "user"
                continue
            if k == "tool_call":
                prev = "tool"
                meta = (u.get("_meta") or {}).get("x.ai/tool") or {}
                names[u.get("toolCallId")] = meta.get("name") or u.get("title") or ""
                raw = u.get("rawInput") if isinstance(u.get("rawInput"), dict) else {}
                files[u.get("toolCallId")] = raw.get("file_path") or raw.get("target_file") or raw.get("path") or ""
            elif k == "tool_call_update" and u.get("status") in ("completed", "failed"):
                ro = u.get("rawOutput") if isinstance(u.get("rawOutput"), dict) else {}
                t = ro.get("type")
                tid = u.get("toolCallId")
                if t in EDIT_TYPES or names.get(tid, "") in EDIT_NAMES:
                    seq.append(("edit", os.path.basename(files.get(tid, "")) or "a file", None))
                res = ro if t == "Bash" else (ro.get("Result") if t == "TaskOutput" else None)
                if isinstance(res, dict) and isinstance(res.get("exit_code"), int) and isinstance(res.get("command"), str):
                    seq.append(("run", res["command"].strip(), res["exit_code"]))
            elif k == "agent_message_chunk":
                prev = "agent"
    return seq, turn


def bump(sid, key, limit):
    """Counts blocks per user turn and kind; False once the limit is reached (loop guard)."""
    os.makedirs(STATE, exist_ok=True)
    f = os.path.join(STATE, sid + ".evidence.json")
    try:
        counts = json.load(open(f))
    except Exception:
        counts = {}
    turn = key.split("-")[0]
    counts = {k: v for k, v in counts.items() if k.split("-")[0] == turn}  # forget older turns
    if counts.get(key, 0) >= limit or sum(counts.values()) >= MAX:
        return False
    counts[key] = counts.get(key, 0) + 1
    with open(f, "w") as fh:
        json.dump(counts, fh)
    return True


def main():
    if os.environ.get("GROK_AUTO_CONTINUE", "1") == "0" or os.environ.get("GM_LONGRUN") == "1":
        return
    try:
        ev = json.load(sys.stdin)
    except Exception:
        return
    if ev.get("reason") not in (None, "end_turn"):
        return
    sid = str(ev.get("sessionId") or "")
    if not re.fullmatch(r"[A-Za-z0-9-]+", sid):
        return
    paths = glob.glob(os.path.join(GH, "sessions", "*", sid, "updates.jsonl"))
    if not paths:
        return
    try:
        seq, turn = turn_events(paths[0])
    except Exception:
        return
    edits = [i for i, e in enumerate(seq) if e[0] == "edit"]
    if not edits:
        return  # nothing changed: questions, research, reviews are never gated
    reply = str(ev.get("lastAssistantMessage") or "").strip()
    if UNTESTED.search(reply):
        return  # the reply says plainly what is untested
    if reply and WAITING.search(reply.split("\n\n")[-1]):
        return
    after = [e for e in seq[edits[-1] + 1:] if e[0] == "run"]
    checks = [e for e in after if is_check(e[1])]
    changed = sorted({e[1] for e in seq if e[0] == "edit"})[:6]
    if not checks:
        if not bump(sid, "%d-unchecked" % turn, MAX):
            return
        ran = [e for e in seq if e[0] == "run" and is_check(e[1])]
        before = ("The last thing you ran was `%s` (exit %d), before your final edits." % (ran[-1][1][:120], ran[-1][2])) if ran else "You ran nothing that executes the code."
        reason = ("Evidence check: you changed %s, but nothing you ran after your last edit exercises it. %s "
                  "Run the check that proves the change does what was asked (its tests, the program itself, the real tool), "
                  "then end with `Checked:` lines giving each command and what it showed. If it really cannot be checked here, "
                  "end with one line `Untested: <what and why>` instead of calling it done." % (", ".join(changed), before))
        print(json.dumps({"decision": "block", "reason": reason}))
        return
    last = checks[-1]
    if last[2] != 0:
        if not bump(sid, "%d-failed" % turn, 1):
            return
        reason = ("Evidence check: your last check after the edits, `%s`, exited %d. If that is the check for this task, it "
                  "failed: fix the cause and rerun it. If the failure is expected or unrelated, say so explicitly in your reply. "
                  "Don't call the task done on a failing check." % (last[1][:160], last[2]))
        print(json.dumps({"decision": "block", "reason": reason}))


main()

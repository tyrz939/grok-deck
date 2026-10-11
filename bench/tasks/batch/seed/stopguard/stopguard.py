#!/usr/bin/env python3
"""Stop guard for our agent runner.

The runner calls this script when the agent wants to end its turn. It passes an event as JSON on stdin:
    {"transcript": "/path/to/transcript.jsonl", "last_message": "the agent's final reply"}
The transcript is JSON lines, one event per line, oldest first:
    {"type": "user", "text": "..."}                   a message from the user
    {"type": "assistant", "text": "..."}              agent text
    {"type": "todos", "items": [{"content": "...", "status": "pending|in_progress|completed|cancelled"}]}
                                                      the agent's full todo list each time it changes
To keep the agent working, print {"decision": "block", "reason": "..."}; print nothing to let it stop.
"""
import json
import re
import sys

WAITING = re.compile(r"(\?\s*$|\b(log ?in|sign ?in|password|approve|approval|waiting (?:on|for) you)\b)", re.I)


def read_events(path):
    events = []
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if line:
                events.append(json.loads(line))
    return events


def latest_todos(events):
    items = []
    for ev in events:
        if ev.get("type") == "todos":
            items = ev.get("items", [])
    return items


def open_items(items):
    return [i for i in items if i.get("status") in ("pending", "in_progress")]


def decide(event):
    events = read_events(event["transcript"])
    items = open_items(latest_todos(events))
    if items:
        return {"decision": "block", "reason": "Open todos: " + "; ".join(i["content"] for i in items)}
    return None


def main():
    event = json.load(sys.stdin)
    result = decide(event)
    if result:
        print(json.dumps(result))


if __name__ == "__main__":
    main()

"""Stop guard for an agent harness: decides whether the agent must keep working before it may end its turn."""
import re

WAITING = re.compile(r"(\?\s*$|\b(log ?in|sign ?in|password|approve|approval|waiting (?:on|for) you)\b)", re.I)


def open_todos(todos):
    return [t for t in todos if t.get("status") in ("pending", "in_progress")]


def should_block(todos, last_message):
    """Return a reason string to keep the agent working, or "" to let it stop."""
    items = open_todos(todos)
    if items:
        return "Your todo list still has open items: " + "; ".join(t["content"] for t in items)
    return ""

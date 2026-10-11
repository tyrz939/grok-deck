import sys
from loader import ProfileError, load_all

try:
    for agent in load_all():
        print("%-10s %-8s %s" % (agent["name"], agent.get("effort", "default"), agent["description"]))
except ProfileError as e:
    print("error:", e, file=sys.stderr)
    sys.exit(1)

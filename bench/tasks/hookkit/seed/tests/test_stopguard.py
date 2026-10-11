import json, subprocess, sys, pathlib

HERE = pathlib.Path(__file__).resolve().parent.parent


def run(tmp_path, events, last):
    t = tmp_path / "t.jsonl"
    t.write_text("\n".join(json.dumps(e) for e in events) + "\n")
    p = subprocess.run([sys.executable, str(HERE / "stopguard.py")], input=json.dumps({"transcript": str(t), "last_message": last}),
                       capture_output=True, text=True)
    return p.stdout.strip()


def test_blocks_on_open_todos(tmp_path):
    out = run(tmp_path, [{"type": "user", "text": "go"}, {"type": "todos", "items": [{"content": "a", "status": "pending"}]}], "did a")
    assert json.loads(out)["decision"] == "block"

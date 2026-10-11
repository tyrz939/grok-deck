"""Loads agent profiles (agents/*.md): a frontmatter block between --- lines, then the prompt body.

The frontmatter is parsed with the same rules as the YAML loader in our runtime: one `key: value` per
line, and a plain (unquoted) value may not contain ": " (that is a nested mapping, which is an error).
Quote such values with double quotes.
"""
import json
import pathlib


class ProfileError(ValueError):
    pass


def parse_value(raw, where):
    raw = raw.strip()
    if raw.startswith('"'):
        try:
            return json.loads(raw)
        except json.JSONDecodeError as e:
            raise ProfileError(where + ": bad quoted string") from e
    if ": " in raw or raw.endswith(":"):
        raise ProfileError(where + ": mapping values are not allowed in this context")
    return raw


def load(path):
    text = pathlib.Path(path).read_text()
    lines = text.split("\n")
    if lines[0] != "---" or "---" not in lines[1:]:
        raise ProfileError(str(path) + ": missing frontmatter")
    end = lines.index("---", 1)
    meta = {}
    for n, line in enumerate(lines[1:end], start=2):
        if not line.strip():
            continue
        key, sep, rest = line.partition(":")
        if not sep:
            raise ProfileError("%s:%d: expected key: value" % (path, n))
        meta[key.strip()] = parse_value(rest, "%s:%d" % (path, n))
    for key in ("name", "description"):
        if key not in meta:
            raise ProfileError("%s: missing %s" % (path, key))
    meta["body"] = "\n".join(lines[end + 1:]).strip()
    return meta


def load_all(folder="agents"):
    return [load(p) for p in sorted(pathlib.Path(folder).glob("*.md"))]

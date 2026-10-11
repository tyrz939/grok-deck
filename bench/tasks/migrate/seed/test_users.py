import os
import tempfile

os.environ["USERS_DB"] = tempfile.mktemp(suffix=".db")
import users  # noqa: E402


def test_add_and_get():
    uid = users.add_user("ann")
    assert users.get_user(uid)["name"] == "ann"

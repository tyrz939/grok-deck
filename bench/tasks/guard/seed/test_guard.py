from guard import should_block


def test_open_todos_block():
    assert should_block([{"content": "write docs", "status": "pending"}], "Done with step one.")


def test_no_todos_allow():
    assert should_block([], "All done.") == ""

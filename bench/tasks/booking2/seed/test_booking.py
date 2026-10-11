import os
import tempfile

os.environ["BOOKING_DB"] = tempfile.mktemp(suffix=".db")
import booking  # noqa: E402


def test_reserve_free_seat():
    assert booking.reserve("A1", "ann")
    assert booking.owner("A1") == "ann"

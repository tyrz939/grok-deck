"""HTTP handlers (framework glue omitted)."""
import booking


def post_booking(seat, user):
    ok = booking.reserve(seat, user)
    return (201, {"seat": seat}) if ok else (409, {"error": "seat taken"})

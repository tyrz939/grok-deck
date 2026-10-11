from booking import Booking
from store import Store

STORE = Store()


async def handle_request(seat, user, store=STORE):
    # A new Booking per request; all requests share one store.
    booking = Booking(store)
    ok = await booking.reserve(seat, user)
    return {"seat": seat, "user": user, "booked": ok}

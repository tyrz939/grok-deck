class Booking:
    def __init__(self, store):
        self.store = store

    async def reserve(self, seat, user):
        """Book seat for user. Returns True if booked, False if the seat is taken."""
        if await self.store.get(seat) is not None:
            return False
        await self.store.put(seat, user)
        return True

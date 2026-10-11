import asyncio


class Store:
    """Async key-value store (stands in for the database client)."""

    def __init__(self):
        self.rows = {}

    async def get(self, key):
        await asyncio.sleep(0.002)
        return self.rows.get(key)

    async def put(self, key, value):
        await asyncio.sleep(0.002)
        self.rows[key] = value

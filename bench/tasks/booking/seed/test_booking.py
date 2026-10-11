import asyncio
from app import handle_request
from store import Store


def test_book_free_seat():
    store = Store()
    assert asyncio.run(handle_request("A1", "ann", store))["booked"]

import os
import sqlite3

PATH = os.environ.get("BOOKING_DB", "bookings.db")


def connect():
    conn = sqlite3.connect(PATH, timeout=10)
    conn.execute("CREATE TABLE IF NOT EXISTS bookings (seat TEXT, user TEXT, at REAL)")
    return conn

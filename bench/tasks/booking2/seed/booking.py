import time

import db
import payments


def reserve(seat, user):
    """Book seat for user. Returns True if booked, False if the seat is taken."""
    conn = db.connect()
    try:
        taken = conn.execute("SELECT 1 FROM bookings WHERE seat = ?", (seat,)).fetchone()
        if taken:
            return False
        payments.authorize(user)  # calls the payment provider
        conn.execute("INSERT INTO bookings (seat, user, at) VALUES (?, ?, ?)", (seat, user, time.time()))
        conn.commit()
        return True
    finally:
        conn.close()


def owner(seat):
    conn = db.connect()
    try:
        row = conn.execute("SELECT user FROM bookings WHERE seat = ?", (seat,)).fetchone()
        return row[0] if row else None
    finally:
        conn.close()

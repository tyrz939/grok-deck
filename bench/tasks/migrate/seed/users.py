import os
import sqlite3

DB = os.environ.get("USERS_DB", os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "app.db"))


def connect():
    conn = sqlite3.connect(DB)
    conn.execute("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
    return conn


def add_user(name):
    conn = connect()
    with conn:
        cur = conn.execute("INSERT INTO users (name) VALUES (?)", (name,))
    return cur.lastrowid


def get_user(user_id):
    conn = connect()
    row = conn.execute("SELECT id, name FROM users WHERE id = ?", (user_id,)).fetchone()
    return {"id": row[0], "name": row[1]} if row else None

"""Flask server for the local Car Wash website.

Install dependencies with ``python -m pip install -r requirements.txt``.
Run locally with ``python server.py`` or deploy with ``gunicorn server:app``.
"""

from contextlib import closing
from datetime import date, time
import hashlib
import json
import logging
import os
from pathlib import Path
import secrets
import sqlite3
import time as time_module

from flask import Flask, abort, jsonify, make_response, request, send_from_directory
from werkzeug.exceptions import BadRequest


ROOT = Path(__file__).resolve().parent
DATABASE = ROOT / "car_wash.db"
HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", "8002"))
SESSION_COOKIE = "carWashSession"
SERVICES = {"BASIC CLEANING", "PREMIUM CLEANING", "COMPLEX CLEANING"}
STATUSES = {"Scheduled", "In progress", "Completed", "Cancelled"}
PASSWORD_ITERATIONS = 310_000
SESSION_EXPIRY_NEVER = 0
MAX_REQUEST_BYTES = 16_384
STATIC_FILES = {
    "appointment.html",
    "dashboard.html",
    "index.html",
    "login.html",
    "script.js",
    "services.html",
    "style.css",
    "user-dashboard.html",
}

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_REQUEST_BYTES
app.logger.setLevel(logging.INFO)


def hash_password(password, salt=None):
    salt = salt or secrets.token_bytes(16)
    password_hash = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS
    )
    return salt.hex(), password_hash.hex()


def initialize_database():
    with closing(sqlite3.connect(DATABASE)) as connection, connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL COLLATE NOCASE UNIQUE,
                password_salt TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                expires_at INTEGER NOT NULL
            )
            """
        )
        connection.execute(
            "UPDATE sessions SET expires_at = ? WHERE expires_at > ?",
            (SESSION_EXPIRY_NEVER, int(time_module.time())),
        )
        admin_exists = connection.execute(
            "SELECT 1 FROM accounts WHERE username = 'admin'"
        ).fetchone()
        if not admin_exists:
            salt, password_hash = hash_password("admin123")
            connection.execute(
                """
                INSERT INTO accounts (username, password_salt, password_hash, role)
                VALUES ('admin', ?, ?, 'admin')
                """,
                (salt, password_hash),
            )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS appointments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                customer TEXT NOT NULL,
                vehicle TEXT NOT NULL,
                service TEXT NOT NULL,
                location TEXT NOT NULL,
                date TEXT NOT NULL,
                time TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'Scheduled',
                account_id INTEGER REFERENCES accounts(id)
            )
            """
        )
        appointment_columns = {
            row[1] for row in connection.execute("PRAGMA table_info(appointments)")
        }
        if "account_id" not in appointment_columns:
            connection.execute(
                "ALTER TABLE appointments ADD COLUMN account_id INTEGER REFERENCES accounts(id)"
            )
        if "created_by" in appointment_columns:
            connection.execute(
                """
                UPDATE appointments
                SET account_id = (
                    SELECT accounts.id FROM accounts
                    WHERE accounts.username = appointments.created_by COLLATE NOCASE
                )
                WHERE account_id IS NULL
                """
            )
            connection.execute("ALTER TABLE appointments DROP COLUMN created_by")


def database_connection():
    connection = sqlite3.connect(DATABASE)
    connection.row_factory = sqlite3.Row
    return connection


def request_payload():
    if request.content_length is not None and request.content_length > MAX_REQUEST_BYTES:
        raise ValueError(f"Request body must not exceed {MAX_REQUEST_BYTES} bytes.")
    if request.content_length in (None, 0):
        raise ValueError("Request body must contain a JSON object.")
    try:
        payload = json.loads(request.get_data(cache=False))
    except (BadRequest, json.JSONDecodeError, UnicodeDecodeError):
        raise ValueError("Request body must contain valid JSON.") from None
    if not isinstance(payload, dict):
        raise ValueError("Request body must be a JSON object.")
    return payload


def authenticated_account():
    authorization = request.headers.get("Authorization", "")
    scheme, separator, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not separator or not token:
        token = request.cookies.get(SESSION_COOKIE, "")
    if not token:
        return None

    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    now = int(time_module.time())
    with closing(database_connection()) as connection, connection:
        account = connection.execute(
            """
            SELECT accounts.id, accounts.username, accounts.role
            FROM sessions
            JOIN accounts ON accounts.id = sessions.account_id
            WHERE sessions.token_hash = ?
                AND (sessions.expires_at = ? OR sessions.expires_at > ?)
            """,
            (token_hash, SESSION_EXPIRY_NEVER, now),
        ).fetchone()
        connection.execute(
            "DELETE FROM sessions WHERE expires_at != ? AND expires_at <= ?",
            (SESSION_EXPIRY_NEVER, now),
        )
    return account


def public_account(account):
    return {
        "id": account["id"],
        "username": account["username"],
        "role": account["role"],
    }


def require_account(role=None):
    account = authenticated_account()
    if account is None:
        return None, (jsonify(error="Please sign in to continue."), 401)
    if role and account["role"] != role:
        return None, (jsonify(error="You do not have permission to do that."), 403)
    return account, None


def create_session(account):
    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    with closing(database_connection()) as connection, connection:
        connection.execute(
            "INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)",
            (token_hash, account["id"], SESSION_EXPIRY_NEVER),
        )
    response = make_response(jsonify(
        token=token,
        account=public_account(account),
    ))
    response.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        path="/",
        samesite="Lax",
    )
    return response


def appointment_from_row(row):
    return {
        "id": row["id"],
        "customer": row["customer"],
        "vehicle": row["vehicle"],
        "service": row["service"],
        "location": row["location"],
        "date": row["date"],
        "time": row["time"],
        "status": row["status"],
    }


def validated_appointment_fields(payload):
    fields = {}
    for name, maximum in (
        ("customer", 80),
        ("vehicle", 80),
        ("service", 40),
        ("location", 160),
        ("date", 10),
        ("time", 8),
    ):
        value = payload.get(name)
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{name} is required.")
        value = value.strip()
        if len(value) > maximum:
            raise ValueError(f"{name} is too long.")
        fields[name] = value
    if fields["service"] not in SERVICES:
        raise ValueError("Choose a valid service.")
    try:
        date.fromisoformat(fields["date"])
        time.fromisoformat(fields["time"])
    except ValueError:
        raise ValueError("Enter a valid appointment date and time.") from None
    return fields


@app.get("/")
def home():
    return send_from_directory(ROOT, "index.html")


@app.get("/assets/<path:filename>")
def assets(filename):
    return send_from_directory(ROOT / "assets", filename)


@app.get("/api/me")
def get_current_account():
    account, error = require_account()
    if error:
        return error
    return jsonify(public_account(account))


@app.get("/api/accounts")
def get_accounts():
    account, error = require_account("admin")
    if error:
        return error
    with closing(database_connection()) as connection:
        accounts = connection.execute(
            "SELECT id, username, role FROM accounts ORDER BY username COLLATE NOCASE"
        ).fetchall()
    return jsonify([public_account(item) for item in accounts])


@app.get("/api/appointments")
def get_appointments():
    account, error = require_account()
    if error:
        return error
    with closing(database_connection()) as connection:
        if account["role"] == "admin":
            rows = connection.execute("SELECT * FROM appointments ORDER BY id").fetchall()
        else:
            rows = connection.execute(
                "SELECT * FROM appointments WHERE account_id = ? ORDER BY id",
                (account["id"],),
            ).fetchall()
    return jsonify([appointment_from_row(row) for row in rows])


@app.post("/api/register")
def register_account():
    try:
        payload = request_payload()
        username = payload.get("username")
        password = payload.get("password")
        if not isinstance(username, str) or not username.strip():
            raise ValueError("Username is required.")
        username = username.strip()
        if len(username) > 80:
            raise ValueError("Username must be 80 characters or fewer.")
        if not isinstance(password, str) or len(password) < 6:
            raise ValueError("Password must be at least 6 characters long.")
        if len(password) > 1024:
            raise ValueError("Password is too long.")
        salt, password_hash = hash_password(password)
        with closing(database_connection()) as connection, connection:
            try:
                connection.execute(
                    """
                    INSERT INTO accounts (username, password_salt, password_hash, role)
                    VALUES (?, ?, ?, 'user')
                    """,
                    (username, salt, password_hash),
                )
            except sqlite3.IntegrityError:
                raise ValueError("That username is already in use.") from None
            account = connection.execute(
                "SELECT id, username, role FROM accounts WHERE username = ?",
                (username,),
            ).fetchone()
        return create_session(account)
    except ValueError as error:
        return jsonify(error=str(error)), 400
    except sqlite3.Error:
        app.logger.exception("Database error while creating account")
        return jsonify(error="Could not create account."), 500


@app.post("/api/login")
def login_account():
    try:
        payload = request_payload()
        username = payload.get("username")
        password = payload.get("password")
        if not isinstance(username, str) or not isinstance(password, str):
            raise ValueError("Enter your username and password.")
        with closing(database_connection()) as connection:
            account = connection.execute(
                "SELECT * FROM accounts WHERE username = ?",
                (username.strip(),),
            ).fetchone()
        if account is None:
            return jsonify(error="Invalid username or password."), 401
        salt = bytes.fromhex(account["password_salt"])
        candidate = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS
        ).hex()
        if not secrets.compare_digest(candidate, account["password_hash"]):
            return jsonify(error="Invalid username or password."), 401
        return create_session(account)
    except ValueError as error:
        return jsonify(error=str(error)), 400
    except sqlite3.Error:
        app.logger.exception("Database error while signing in")
        return jsonify(error="Could not sign in."), 500


@app.post("/api/logout")
def logout_account():
    _, error = require_account()
    if error:
        return error
    authorization = request.headers.get("Authorization", "")
    token = authorization.partition(" ")[2]
    if not token:
        token = request.cookies.get(SESSION_COOKIE, "")
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    with closing(database_connection()) as connection, connection:
        connection.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))
    response = make_response(jsonify(loggedOut=True))
    response.delete_cookie(
        SESSION_COOKIE,
        path="/",
        httponly=True,
        samesite="Lax",
    )
    return response


@app.post("/api/appointments")
def create_appointment():
    try:
        account = authenticated_account()
        fields = validated_appointment_fields(request_payload())
        with closing(database_connection()) as connection, connection:
            cursor = connection.execute(
                """
                INSERT INTO appointments
                    (customer, vehicle, service, location, date, time, account_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    fields["customer"],
                    fields["vehicle"],
                    fields["service"],
                    fields["location"],
                    fields["date"],
                    fields["time"],
                    account["id"] if account else None,
                ),
            )
            row = connection.execute(
                "SELECT * FROM appointments WHERE id = ?", (cursor.lastrowid,)
            ).fetchone()
        return jsonify(appointment_from_row(row)), 201
    except ValueError as error:
        return jsonify(error=str(error)), 400
    except sqlite3.Error:
        app.logger.exception("Database error while creating appointment")
        return jsonify(error="Could not save appointment."), 500


@app.patch("/api/appointments/<int:appointment_id>")
def update_appointment(appointment_id):
    if appointment_id <= 0:
        abort(404)
    try:
        account, error = require_account()
        if error:
            return error
        status = request_payload().get("status")
        if not isinstance(status, str) or status not in STATUSES:
            raise ValueError("Choose a valid appointment status.")
        with closing(database_connection()) as connection, connection:
            if account["role"] == "admin":
                cursor = connection.execute(
                    "UPDATE appointments SET status = ? WHERE id = ?",
                    (status, appointment_id),
                )
            elif status == "Cancelled":
                cursor = connection.execute(
                    """
                    UPDATE appointments SET status = ?
                    WHERE id = ? AND account_id = ? AND status = 'Scheduled'
                    """,
                    (status, appointment_id, account["id"]),
                )
            else:
                return jsonify(error="You do not have permission to do that."), 403
        if cursor.rowcount == 0:
            return jsonify(error="Appointment not found."), 404
        return jsonify(id=appointment_id, status=status)
    except ValueError as error:
        return jsonify(error=str(error)), 400
    except sqlite3.Error:
        app.logger.exception("Database error while updating appointment")
        return jsonify(error="Could not update appointment."), 500


@app.delete("/api/appointments/<int:appointment_id>")
def delete_appointment(appointment_id):
    if appointment_id <= 0:
        abort(404)
    account, error = require_account("admin")
    if error:
        return error
    try:
        with closing(database_connection()) as connection, connection:
            cursor = connection.execute(
                "DELETE FROM appointments WHERE id = ?", (appointment_id,)
            )
        if cursor.rowcount == 0:
            return jsonify(error="Appointment not found."), 404
        return jsonify(deleted=appointment_id)
    except sqlite3.Error:
        app.logger.exception("Database error while deleting appointment")
        return jsonify(error="Could not delete appointment."), 500


@app.get("/<path:filename>")
def static_file(filename):
    if filename not in STATIC_FILES:
        abort(404)
    return send_from_directory(ROOT, filename)


@app.errorhandler(413)
def request_too_large(_error):
    return jsonify(error=f"Request body must not exceed {MAX_REQUEST_BYTES} bytes."), 413


# Initialize the database when imported by a WSGI server such as Gunicorn.
initialize_database()


if __name__ == "__main__":
    print(f"Car Wash website listening on {HOST}:{PORT}")
    print(f"Appointments are stored in {DATABASE.name}.")
    print("Default administrator login: admin / admin123")
    print("Press Ctrl+C to stop the server.")
    app.run(host=HOST, port=PORT, debug=False, threaded=True, use_reloader=False)

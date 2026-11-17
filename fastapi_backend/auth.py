from __future__ import annotations

import os
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, TypedDict

import bcrypt
import jwt
from fastapi import Depends, HTTPException, Request

JWT_SECRET = os.getenv("JWT_SECRET", "lexiforge-dev-jwt-secret-change-in-prod")
JWT_ALGORITHM = "HS256"
JWT_EXPIRES_DAYS = 7

_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$")


class JwtPayload(TypedDict):
    userId: int
    email: str
    role: Literal["user", "admin"]


def hash_password(password: str) -> str:
    salt = bcrypt.gensalt(rounds=10)
    return bcrypt.hashpw(password.encode("utf-8"), salt).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except Exception:
        return False


def normalize_email(raw: str) -> str:
    return raw.strip().lower()


def is_valid_email(email: str) -> bool:
    return bool(_EMAIL_RE.match(email))


def get_canonical_email(raw: str) -> str:
    norm = normalize_email(raw)
    if "@" not in norm:
        return norm
    local, domain = norm.rsplit("@", 1)
    if "+" in local:
        local = local.split("+", 1)[0]
    if domain == "googlemail.com":
        domain = "gmail.com"
    if domain == "gmail.com":
        local = local.replace(".", "")
    if domain in ("ya.ru", "yandex.com"):
        domain = "yandex.ru"
    return f"{local}@{domain}"


def sign_jwt(payload: JwtPayload) -> str:
    now = datetime.now(timezone.utc)
    claims: dict[str, Any] = {
        "userId": payload["userId"],
        "email": payload["email"],
        "role": payload["role"],
        "iat": now,
        "exp": now + timedelta(days=JWT_EXPIRES_DAYS),
    }
    return jwt.encode(claims, JWT_SECRET, algorithm=JWT_ALGORITHM)


def verify_jwt(token: str) -> JwtPayload | None:
    try:
        decoded = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        user_id = decoded.get("userId")
        if not isinstance(user_id, int):
            return None
        return {
            "userId": user_id,
            "email": str(decoded.get("email", "")),
            "role": "admin" if decoded.get("role") == "admin" else "user",
        }
    except Exception:
        return None


def extract_token_from_request(request: Request) -> str | None:
    auth_header = request.headers.get("authorization")
    if auth_header and auth_header.startswith("Bearer "):
        return auth_header[7:].strip()
    cookie_val = request.cookies.get("lexiforge_token")
    if cookie_val:
        return cookie_val
    return None


async def require_auth(request: Request) -> JwtPayload:
    token = extract_token_from_request(request)
    if not token:
        raise HTTPException(
            status_code=401,
            detail="Требуется авторизация (отсутствует JWT-токен)",
        )
    payload = verify_jwt(token)
    if not payload:
        raise HTTPException(
            status_code=401,
            detail="Недействительный или истекший JWT-токен",
        )
    return payload


async def require_admin(user: JwtPayload = Depends(require_auth)) -> JwtPayload:
    if user["role"] != "admin":
        raise HTTPException(
            status_code=403,
            detail="Доступ запрещен: требуются права администратора",
        )
    return user

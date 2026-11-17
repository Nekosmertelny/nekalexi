from __future__ import annotations

import asyncio
import json
import sqlite3
from datetime import datetime, timezone
from typing import Any

from fastapi import WebSocket


class WsNotificationHub:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn
        self.clients_by_user: dict[int, set[WebSocket]] = {}
        self._task: asyncio.Task[None] | None = None

    def register(self, user_id: int, ws: WebSocket) -> None:
        self.clients_by_user.setdefault(user_id, set()).add(ws)

    def unregister(self, user_id: int, ws: WebSocket) -> None:
        sockets = self.clients_by_user.get(user_id)
        if not sockets:
            return
        sockets.discard(ws)
        if not sockets:
            self.clients_by_user.pop(user_id, None)

    def get_online_count(self) -> int:
        return len(self.clients_by_user)

    async def send_to_user(self, user_id: int, event_type: str, payload: Any) -> None:
        sockets = list(self.clients_by_user.get(user_id, ()))
        if not sockets:
            return
        message = json.dumps(
            {
                "type": event_type,
                "payload": payload,
                "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            }
        )
        for ws in sockets:
            try:
                await ws.send_text(message)
            except Exception:
                self.unregister(user_id, ws)

    async def broadcast_all(self, event_type: str, payload: Any) -> None:
        message = json.dumps(
            {
                "type": event_type,
                "payload": payload,
                "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            }
        )
        for user_id, sockets in list(self.clients_by_user.items()):
            for ws in list(sockets):
                try:
                    await ws.send_text(message)
                except Exception:
                    self.unregister(user_id, ws)

    def start_reminder_loop(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._reminder_loop())

    async def stop_reminder_loop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _reminder_loop(self) -> None:
        while True:
            await asyncio.sleep(60)
            await self._check_daily_reminders()

    async def _check_daily_reminders(self) -> None:
        if not self.clients_by_user:
            return
        now = datetime.now(timezone.utc)
        hhmm = now.strftime("%H:%M")
        today_str = now.strftime("%Y-%m-%d")

        for user_id in list(self.clients_by_user.keys()):
            user = self.conn.execute(
                "SELECT id, reminder_enabled, reminder_time, daily_goal FROM users WHERE id = ? AND is_active = 1",
                (user_id,),
            ).fetchone()
            if not user or not user["reminder_enabled"] or user["reminder_time"] != hhmm:
                continue

            today_count = self.conn.execute(
                "SELECT COUNT(*) AS cnt FROM review_logs WHERE user_id = ? AND date(reviewed_at) = ?",
                (user_id, today_str),
            ).fetchone()["cnt"]
            if today_count >= user["daily_goal"]:
                continue

            already = self.conn.execute(
                """
                SELECT 1 FROM notifications
                WHERE user_id = ? AND type = 'reminder' AND title = 'Время ежедневной практики' AND date(created_at) = ?
                """,
                (user_id, today_str),
            ).fetchone()
            if already:
                continue

            remaining = int(user["daily_goal"]) - int(today_count)
            title = "Время ежедневной практики"
            message = f"До вашей дневной цели осталось повторить {remaining} слов."
            cur = self.conn.execute(
                "INSERT INTO notifications (user_id, type, title, message) VALUES (?, 'reminder', ?, ?)",
                (user_id, title, message),
            )
            self.conn.commit()
            await self.send_to_user(
                user_id,
                "reminder:due",
                {
                    "id": cur.lastrowid,
                    "type": "reminder",
                    "title": title,
                    "message": message,
                    "is_read": 0,
                    "created_at": now.isoformat().replace("+00:00", "Z"),
                },
            )

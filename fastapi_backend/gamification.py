from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ws_hub import WsNotificationHub


def calculate_level_from_xp(xp: int) -> int:
    return max(1, (xp // 100) + 1)


def award_user_xp(
    conn: sqlite3.Connection,
    user_id: int,
    xp_delta: int,
    update_study_streak: bool,
) -> dict[str, int]:
    user = conn.execute(
        "SELECT xp, level, streak_days, last_study_date FROM users WHERE id = ?",
        (user_id,),
    ).fetchone()
    if not user:
        raise ValueError("Пользователь не найден")

    new_xp = int(user["xp"]) + xp_delta
    new_level = calculate_level_from_xp(new_xp)
    new_streak = int(user["streak_days"])
    new_last_study_date = user["last_study_date"]

    if update_study_streak:
        now = datetime.now(timezone.utc)
        today = now.strftime("%Y-%m-%d")
        yesterday = (now - timedelta(days=1)).strftime("%Y-%m-%d")
        if user["last_study_date"] == today:
            new_streak = max(1, new_streak)
        elif user["last_study_date"] == yesterday:
            new_streak += 1
        else:
            new_streak = 1
        new_last_study_date = today

    conn.execute(
        "UPDATE users SET xp = ?, level = ?, streak_days = ?, last_study_date = ? WHERE id = ?",
        (new_xp, new_level, new_streak, new_last_study_date, user_id),
    )
    conn.commit()
    return {"xp": new_xp, "level": new_level, "streak_days": new_streak}


async def evaluate_and_unlock_achievements(
    conn: sqlite3.Connection,
    user_id: int,
    ws_hub: WsNotificationHub | None = None,
) -> list[dict[str, Any]]:
    user = conn.execute("SELECT streak_days FROM users WHERE id = ?", (user_id,)).fetchone()
    if not user:
        return []

    words_count = conn.execute(
        "SELECT COUNT(*) AS cnt FROM words WHERE user_id = ?", (user_id,)
    ).fetchone()["cnt"]
    mastered_count = conn.execute(
        "SELECT COUNT(*) AS cnt FROM words WHERE user_id = ? AND status = 'mastered'",
        (user_id,),
    ).fetchone()["cnt"]
    reviews_count = conn.execute(
        "SELECT COUNT(*) AS cnt FROM review_logs WHERE user_id = ?", (user_id,)
    ).fetchone()["cnt"]
    writing_count = conn.execute(
        "SELECT COUNT(*) AS cnt FROM writing_submissions WHERE user_id = ?", (user_id,)
    ).fetchone()["cnt"]
    max_grammar = conn.execute(
        "SELECT COALESCE(MAX(grammar_score), 0) AS m FROM writing_submissions WHERE user_id = ?",
        (user_id,),
    ).fetchone()["m"]

    metric_by_code = {
        "first_word": words_count,
        "vocab_20": words_count,
        "first_review": reviews_count,
        "streak_7": user["streak_days"],
        "master_5": mastered_count,
        "writer_5": writing_count,
        "grammar_90": max_grammar,
    }

    locked = conn.execute(
        """
        SELECT a.* FROM achievements a
        WHERE a.id NOT IN (SELECT achievement_id FROM user_achievements WHERE user_id = ?)
        """,
        (user_id,),
    ).fetchall()

    unlocked_now: list[dict[str, Any]] = []
    for ach in locked:
        val = metric_by_code.get(ach["code"], 0)
        if val >= ach["threshold"]:
            conn.execute(
                "INSERT OR IGNORE INTO user_achievements (user_id, achievement_id) VALUES (?, ?)",
                (user_id, ach["id"]),
            )
            award_user_xp(conn, user_id, int(ach["xp_reward"]), False)

            title = f"Достижение разблокировано: {ach['title']}"
            message = f"{ach['description']} (+{ach['xp_reward']} XP)"
            cur = conn.execute(
                "INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)",
                (user_id, "achievement", title, message),
            )
            conn.commit()

            unlocked_now.append(
                {
                    "code": ach["code"],
                    "title": ach["title"],
                    "description": ach["description"],
                    "xp_reward": ach["xp_reward"],
                }
            )

            if ws_hub:
                await ws_hub.send_to_user(
                    user_id,
                    "achievement:unlocked",
                    {
                        "id": cur.lastrowid,
                        "code": ach["code"],
                        "title": title,
                        "message": message,
                        "xp_reward": ach["xp_reward"],
                        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                    },
                )

    return unlocked_now

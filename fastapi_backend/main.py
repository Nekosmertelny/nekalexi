from __future__ import annotations

import asyncio
import json
import os
import re
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse

import httpx
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from ai import (
    AiServiceError,
    enrich_vocabulary_word,
    evaluate_context_writing,
    evaluate_locally_without_ai,
    evaluate_translation_attempt,
    generate_learning_report,
    generate_translation_prompt,
    to_friendly_ai_error,
)
from auth import (
    JwtPayload,
    get_canonical_email,
    hash_password,
    is_valid_email,
    normalize_email,
    require_admin,
    require_auth,
    sign_jwt,
    verify_jwt,
    verify_password,
)
from curated_catalog import STARTER_WORD_IMAGES, normalize_cefr_level
from db import init_database, seed_starter_words_for_level
from dictionary import lookup_english_dictionary, lookup_word_image, parse_word_list_input
from fsrs_engine import calculate_fsrs, preview_all_fsrs_intervals
from gamification import award_user_xp, evaluate_and_unlock_achievements
from ws_hub import WsNotificationHub

load_dotenv()

_db_conn = init_database()
_ws_hub = WsNotificationHub(_db_conn)
_tts_audio_cache: dict[str, bytes] = {}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    _ws_hub.start_reminder_loop()
    yield
    await _ws_hub.stop_reminder_loop()
    _db_conn.close()


app = FastAPI(title="nekaLexi FastAPI Backend", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(HTTPException)
async def http_exception_handler(_request: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"error": str(exc.detail)})


def _row_to_dict(row: Any) -> dict[str, Any]:
    return dict(row) if row is not None else {}


def _sanitize_user(row: Any) -> dict[str, Any]:
    d = _row_to_dict(row)
    d.pop("password_hash", None)
    return d


def _safe_json_array(raw: Any) -> list[Any]:
    try:
        parsed = json.loads(str(raw or "[]"))
        return parsed if isinstance(parsed, list) else []
    except Exception:
        return []


def _set_auth_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key="lexiforge_token",
        value=token,
        httponly=True,
        secure=True,
        samesite="none",
        max_age=7 * 24 * 60 * 60,
    )


def _load_user_word_hints(user_id: int, target_words: list[str]) -> list[dict[str, Any]]:
    if not target_words:
        return []
    placeholders = ", ".join("?" for _ in target_words)
    rows = _db_conn.execute(
        f"""
        SELECT word, translation, example_en, example_ru, secondary_example_en, secondary_example_ru, cefr_level
        FROM words WHERE user_id = ? AND lower(word) IN ({placeholders})
        """,
        [user_id, *[w.lower() for w in target_words]],
    ).fetchall()
    return [
        {
            "word": r["word"],
            "translation": r["translation"],
            "exampleEn": r["example_en"],
            "exampleRu": r["example_ru"],
            "secondaryExampleEn": r["secondary_example_en"],
            "secondaryExampleRu": r["secondary_example_ru"],
            "cefrLevel": r["cefr_level"],
        }
        for r in rows
    ]


# =========================================================================
# Health, Media & Audio TTS
# =========================================================================
@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "backend": "fastapi",
        "onlineWsClients": _ws_hub.get_online_count(),
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


@app.get("/api/media/download")
async def media_download(url: str = Query(""), name: str = Query("nekalexi-photo.jpg")) -> Response:
    filename = re.sub(r"[^a-zA-Z0-9._-]", "_", name)
    try:
        parsed = urlparse(url)
        allowed = {"upload.wikimedia.org", "thumb.wikimedia.org", "api.openverse.org"}
        if parsed.scheme != "https" or parsed.hostname not in allowed:
            raise HTTPException(status_code=400, detail="Недопустимый источник изображения")
        async with httpx.AsyncClient(timeout=10.0) as client:
            upstream = await client.get(url, headers={"User-Agent": "nekaLexi/1.0 (CC0 Media Downloader)"})
        if upstream.status_code != 200:
            raise HTTPException(status_code=502, detail="Не удалось загрузить файл с Wikimedia Commons")
        ct = upstream.headers.get("content-type", "image/jpeg")
        return Response(
            content=upstream.content,
            media_type=ct,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="Некорректная ссылка на изображение")


@app.get("/api/audio/tts")
async def audio_tts(text: str = Query(""), _user: JwtPayload = Depends(require_auth)) -> Response:
    clean_text = re.sub(r"\s+", " ", text.strip())[:220]
    if not clean_text:
        raise HTTPException(status_code=400, detail="Укажите текст для озвучивания")

    cache_key = clean_text.lower()
    if cache_key in _tts_audio_cache:
        return Response(
            content=_tts_audio_cache[cache_key],
            media_type="audio/mpeg",
            headers={"Cache-Control": "private, max-age=86400"},
        )

    candidates: list[tuple[str, dict[str, str]]] = []
    if " " not in clean_text:
        row = _db_conn.execute(
            "SELECT audio_url FROM words WHERE lower(word) = ? AND audio_url != '' LIMIT 1",
            (cache_key,),
        ).fetchone()
        if row and str(row["audio_url"]).startswith("https://"):
            candidates.append((str(row["audio_url"]), {}))

    candidates.append(
        (
            f"https://translate.googleapis.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q={quote(clean_text)}",
            {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
                "Referer": "https://translate.google.com/",
            },
        )
    )

    async with httpx.AsyncClient(timeout=5.0) as client:
        for cand_url, headers in candidates:
            try:
                upstream = await client.get(cand_url, headers=headers)
                if upstream.status_code != 200 or len(upstream.content) < 256:
                    continue
                ct = upstream.headers.get("content-type", "")
                if len(_tts_audio_cache) > 200:
                    _tts_audio_cache.pop(next(iter(_tts_audio_cache)))
                _tts_audio_cache[cache_key] = upstream.content
                return Response(
                    content=upstream.content,
                    media_type=ct if "audio" in ct else "audio/mpeg",
                    headers={"Cache-Control": "private, max-age=86400"},
                )
            except Exception:
                continue

    raise HTTPException(status_code=502, detail="Сервер озвучивания временно недоступен")


# =========================================================================
# Auth (Email & JWT)
# =========================================================================
@app.post("/api/auth/register", status_code=201)
async def auth_register(request: Request, response: Response) -> dict[str, Any]:
    body = await request.json()
    clean_name = str(body.get("name") or "").strip()
    norm_email = normalize_email(str(body.get("email") or ""))
    raw_password = str(body.get("password") or "")

    if not norm_email or not raw_password or not clean_name:
        raise HTTPException(status_code=400, detail="Заполните имя, email и пароль")
    if len(clean_name) < 2:
        raise HTTPException(status_code=400, detail="Имя должно содержать минимум 2 символа")
    if not is_valid_email(norm_email):
        raise HTTPException(status_code=400, detail="Введите корректный адрес электронной почты")
    if len(raw_password) < 6:
        raise HTTPException(status_code=400, detail="Пароль должен содержать минимум 6 символов")

    canonical = get_canonical_email(norm_email)
    existing = _db_conn.execute(
        "SELECT id FROM users WHERE lower(trim(email)) = ? OR canonical_email = ?",
        (norm_email, canonical),
    ).fetchone()
    if existing:
        raise HTTPException(
            status_code=409,
            detail="Аккаунт с такой электронной почтой уже зарегистрирован. Войдите в существующий профиль.",
        )

    cefr_level = normalize_cefr_level(body.get("cefrLevel"))
    pw_hash = hash_password(raw_password)
    cur = _db_conn.execute(
        """
        INSERT INTO users (email, canonical_email, name, password_hash, role, cefr_level, xp, level, streak_days)
        VALUES (?, ?, ?, ?, 'user', ?, 0, 1, 0)
        """,
        (norm_email, canonical, clean_name, pw_hash, cefr_level),
    )
    _db_conn.commit()
    user_id = int(cur.lastrowid)

    seed_starter_words_for_level(_db_conn, user_id, cefr_level)
    user = _db_conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    token = sign_jwt({"userId": user_id, "email": norm_email, "role": "user"})
    _set_auth_cookie(response, token)
    return {"token": token, "user": _sanitize_user(user)}


@app.post("/api/auth/login")
async def auth_login(request: Request, response: Response) -> dict[str, Any]:
    body = await request.json()
    identifier = str(body.get("email") or "")
    raw_password = str(body.get("password") or "")
    if not identifier or not raw_password:
        raise HTTPException(status_code=400, detail="Введите логин/email и пароль")

    norm_ident = normalize_email(identifier)
    matched = _db_conn.execute(
        "SELECT * FROM users WHERE lower(trim(email)) = ?", (norm_ident,)
    ).fetchone()
    if not matched and is_valid_email(norm_ident):
        matched = _db_conn.execute(
            "SELECT * FROM users WHERE canonical_email = ?",
            (get_canonical_email(norm_ident),),
        ).fetchone()

    if matched:
        if not matched["password_hash"] or not verify_password(raw_password, matched["password_hash"]):
            raise HTTPException(status_code=401, detail="Неверный логин или пароль")
    else:
        candidates = _db_conn.execute(
            "SELECT * FROM users WHERE lower(trim(name)) = ?", (norm_ident,)
        ).fetchall()
        matched = next(
            (c for c in candidates if c["password_hash"] and verify_password(raw_password, c["password_hash"])),
            None,
        )

    if not matched:
        raise HTTPException(status_code=401, detail="Неверный логин или пароль")
    if not matched["is_active"]:
        raise HTTPException(status_code=403, detail="Аккаунт деактивирован администратором")

    role = "admin" if matched["role"] == "admin" else "user"
    token = sign_jwt({"userId": int(matched["id"]), "email": str(matched["email"]), "role": role})
    _set_auth_cookie(response, token)
    return {"token": token, "user": _sanitize_user(matched)}


@app.post("/api/auth/logout")
async def auth_logout(response: Response) -> dict[str, bool]:
    response.delete_cookie("lexiforge_token", samesite="none", secure=True)
    return {"ok": True}


@app.get("/api/auth/me")
async def auth_me(user: JwtPayload = Depends(require_auth)) -> dict[str, Any]:
    row = _db_conn.execute("SELECT * FROM users WHERE id = ?", (user["userId"],)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    today_reviews = _db_conn.execute(
        "SELECT COUNT(*) AS cnt FROM review_logs WHERE user_id = ? AND date(reviewed_at) = ?",
        (user["userId"], today_str),
    ).fetchone()["cnt"]
    return {"user": _sanitize_user(row), "todayReviews": today_reviews}


@app.put("/api/auth/level")
async def auth_level(request: Request, user: JwtPayload = Depends(require_auth)) -> dict[str, Any]:
    body = await request.json()
    cefr_level = normalize_cefr_level(body.get("cefrLevel"))
    seed_deck = body.get("seedDeck", True) is not False

    _db_conn.execute("UPDATE users SET cefr_level = ? WHERE id = ?", (cefr_level, user["userId"]))
    _db_conn.commit()
    added_count = seed_starter_words_for_level(_db_conn, user["userId"], cefr_level)["addedCount"] if seed_deck else 0
    row = _db_conn.execute("SELECT * FROM users WHERE id = ?", (user["userId"],)).fetchone()
    return {"user": _sanitize_user(row), "addedCount": added_count}


# =========================================================================
# Decks & Vocabulary
# =========================================================================
@app.get("/api/decks")
async def get_decks(user: JwtPayload = Depends(require_auth)) -> dict[str, Any]:
    uid = user["userId"]
    rows = _db_conn.execute(
        """
        SELECT d.*,
          (SELECT COUNT(*) FROM words w WHERE w.deck_id = d.id AND w.user_id = ?) AS word_count,
          (SELECT COUNT(*) FROM words w WHERE w.deck_id = d.id AND w.user_id = ? AND (w.next_review_at <= datetime('now') OR w.status = 'new')) AS due_count,
          (SELECT COUNT(*) FROM words w WHERE w.deck_id = d.id) AS total_deck_words
        FROM decks d
        WHERE d.user_id = ? OR d.is_curated = 1
        ORDER BY d.is_curated DESC, d.created_at DESC
        """,
        (uid, uid, uid),
    ).fetchall()
    return {"decks": [_row_to_dict(r) for r in rows]}


@app.post("/api/decks", status_code=201)
async def create_deck(request: Request, user: JwtPayload = Depends(require_auth)) -> dict[str, Any]:
    body = await request.json()
    title = str(body.get("title") or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="Название колоды обязательно")
    cur = _db_conn.execute(
        "INSERT INTO decks (user_id, title, description, category, cefr_level, is_curated) VALUES (?, ?, ?, ?, ?, 0)",
        (
            user["userId"],
            title,
            str(body.get("description") or "").strip(),
            str(body.get("category") or "Личная подборка").strip(),
            str(body.get("cefrLevel") or "B1").strip(),
        ),
    )
    _db_conn.commit()
    deck = _db_conn.execute("SELECT * FROM decks WHERE id = ?", (cur.lastrowid,)).fetchone()
    return {"deck": _row_to_dict(deck)}


@app.post("/api/decks/{deck_id}/clone")
async def clone_deck(deck_id: int, user: JwtPayload = Depends(require_auth)) -> dict[str, int]:
    uid = user["userId"]
    raw_words = _db_conn.execute("SELECT * FROM words WHERE deck_id = ? ORDER BY id ASC", (deck_id,)).fetchall()
    seen: set[str] = set()
    added = 0
    for w in raw_words:
        word_str = str(w["word"] or "")
        key = word_str.strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        img = str(w["image_url"] or "") or STARTER_WORD_IMAGES.get(key, "")
        cur = _db_conn.execute(
            """
            INSERT INTO words (
              user_id, deck_id, word, phonetic, part_of_speech, translation,
              example_en, example_ru, secondary_example_en, secondary_example_ru,
              cefr_level, audio_url, image_url, status
            )
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new'
            WHERE NOT EXISTS (SELECT 1 FROM words WHERE user_id = ? AND lower(word) = lower(?))
            """,
            (
                uid, deck_id, word_str, w["phonetic"], w["part_of_speech"], w["translation"],
                w["example_en"], w["example_ru"], w["secondary_example_en"] or "",
                w["secondary_example_ru"] or "", w["cefr_level"] or "B1", w["audio_url"] or "",
                img, uid, word_str,
            ),
        )
        if cur.rowcount > 0:
            added += 1
    _db_conn.commit()
    return {"added": added}


@app.delete("/api/decks/{deck_id}")
async def delete_deck(deck_id: int, user: JwtPayload = Depends(require_auth)) -> dict[str, bool]:
    deck = _db_conn.execute("SELECT id, user_id FROM decks WHERE id = ?", (deck_id,)).fetchone()
    if not deck:
        raise HTTPException(status_code=404, detail="Колода не найдена")
    if deck["user_id"] != user["userId"] and user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Нет прав на удаление этой колоды")
    _db_conn.execute("DELETE FROM decks WHERE id = ?", (deck_id,))
    _db_conn.commit()
    return {"ok": True}


@app.get("/api/decks/{deck_id}/export")
async def export_deck(deck_id: int, user: JwtPayload = Depends(require_auth)) -> Response:
    rows = _db_conn.execute(
        "SELECT word, translation, part_of_speech, phonetic, example_en, example_ru FROM words WHERE deck_id = ? AND user_id = ?",
        (deck_id, user["userId"]),
    ).fetchall()
    esc = lambda s: f'"{str(s or "").replace(chr(34), chr(34)*2)}"'
    lines = ["word,translation,part_of_speech,phonetic,example_en,example_ru"]
    for w in rows:
        lines.append(",".join(esc(w[c]) for c in ("word", "translation", "part_of_speech", "phonetic", "example_en", "example_ru")))
    return Response(
        content="\n".join(lines),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="nekalexi-deck-{deck_id}.csv"'},
    )


@app.get("/api/words")
async def get_words(
    deckId: int | None = Query(None),
    status: str = Query(""),
    search: str = Query(""),
    user: JwtPayload = Depends(require_auth),
) -> dict[str, Any]:
    conds = ["w.user_id = ?"]
    params: list[Any] = [user["userId"]]
    if deckId:
        conds.append("w.deck_id = ?")
        params.append(deckId)
    if status in ("new", "learning", "review", "mastered"):
        conds.append("w.status = ?")
        params.append(status)
    if search.strip():
        q = f"%{search.strip().lower()}%"
        conds.append("(lower(w.word) LIKE ? OR lower(w.translation) LIKE ?)")
        params.extend([q, q])
    rows = _db_conn.execute(
        f"""
        SELECT w.*, d.title AS deck_title
        FROM words w LEFT JOIN decks d ON d.id = w.deck_id
        WHERE {' AND '.join(conds)}
        ORDER BY w.created_at DESC, w.id DESC
        """,
        params,
    ).fetchall()
    return {"words": [_row_to_dict(r) for r in rows]}


@app.get("/api/words/lookup")
async def lookup_word(
    word: str = Query(""),
    pos: str = Query(""),
    _user: JwtPayload = Depends(require_auth),
) -> dict[str, Any]:
    raw_word = word.strip()
    requested_pos = pos.strip()
    if not raw_word:
        raise HTTPException(status_code=400, detail="Укажите слово для поиска в словаре")
    dict_res = await lookup_english_dictionary(raw_word, requested_pos)
    effective_pos = requested_pos or dict_res["partOfSpeech"] or "noun"
    starter_img = STARTER_WORD_IMAGES.get(raw_word.lower())
    img_coro = (
        asyncio.sleep(0, result=starter_img)
        if starter_img
        else lookup_word_image(
            raw_word,
            part_of_speech=effective_pos,
            english_definition=dict_res["englishDefinition"],
        )
    )
    enriched, photo_url = await asyncio.gather(
        enrich_vocabulary_word(raw_word, dict_res, None, effective_pos), img_coro
    )
    return {"dictionary": dict_res, "enriched": enriched, "imageUrl": photo_url}


@app.post("/api/words", status_code=201)
async def create_word(request: Request, user: JwtPayload = Depends(require_auth)) -> dict[str, Any]:
    body = await request.json()
    clean_word = str(body.get("word") or "").strip()
    if not clean_word:
        raise HTTPException(status_code=400, detail="Введите английское слово или выражение")

    requested_pos = str(body.get("partOfSpeech") or "").strip()
    dict_res = await lookup_english_dictionary(clean_word, requested_pos)
    effective_pos = requested_pos or dict_res["partOfSpeech"] or "noun"
    custom_img = str(body.get("imageUrl") or "")
    starter_img = STARTER_WORD_IMAGES.get(clean_word.lower(), "")
    preset_img = custom_img if custom_img.startswith("https://") else starter_img

    translation = body.get("translation")
    example_en = body.get("exampleEn")
    example_ru = body.get("exampleRu")
    needs_enrichment = not translation or not example_en or not example_ru

    enrich_coro = (
        enrich_vocabulary_word(
            clean_word, dict_res, str(translation).strip() if translation else None, effective_pos
        )
        if needs_enrichment
        else asyncio.sleep(0, result=None)
    )
    img_coro = (
        asyncio.sleep(0, result=preset_img)
        if preset_img
        else lookup_word_image(
            clean_word,
            part_of_speech=effective_pos,
            english_definition=dict_res["englishDefinition"],
        )
    )
    enriched, resolved_img = await asyncio.gather(enrich_coro, img_coro)

    e = enriched or {}
    cur = _db_conn.execute(
        """
        INSERT INTO words (
          user_id, deck_id, word, phonetic, part_of_speech, translation,
          example_en, example_ru, secondary_example_en, secondary_example_ru,
          cefr_level, audio_url, image_url, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')
        """,
        (
            user["userId"],
            int(body["deckId"]) if body.get("deckId") else None,
            clean_word,
            str(body.get("phonetic") or dict_res["phonetic"] or e.get("phonetic") or "").strip(),
            str(requested_pos or e.get("partOfSpeech") or dict_res["partOfSpeech"] or "noun").strip(),
            str(translation or e.get("translation") or clean_word).strip(),
            str(example_en or e.get("exampleEn") or "").strip(),
            str(example_ru or e.get("exampleRu") or "").strip(),
            str(body.get("secondaryExampleEn") or e.get("secondaryExampleEn") or "").strip(),
            str(body.get("secondaryExampleRu") or e.get("secondaryExampleRu") or "").strip(),
            str(body.get("cefrLevel") or e.get("cefrLevel") or "B1").strip(),
            dict_res["audioUrl"] or "",
            resolved_img or "",
        ),
    )
    _db_conn.commit()
    award_user_xp(_db_conn, user["userId"], 10, False)
    unlocked = await evaluate_and_unlock_achievements(_db_conn, user["userId"], _ws_hub)
    created = _db_conn.execute("SELECT * FROM words WHERE id = ?", (cur.lastrowid,)).fetchone()
    return {"word": _row_to_dict(created), "unlockedAchievements": unlocked}


@app.post("/api/words/{word_id}/refresh-image")
async def refresh_word_image(
    word_id: int, request: Request, user: JwtPayload = Depends(require_auth)
) -> dict[str, str]:
    row = _db_conn.execute(
        "SELECT id, user_id, word, part_of_speech, image_url FROM words WHERE id = ?", (word_id,)
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Слово не найдено")
    if row["user_id"] != user["userId"] and user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Нет прав на изменение этого слова")

    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    custom_query = str(body.get("query") or "").strip()
    starter_img = STARTER_WORD_IMAGES.get(str(row["word"]).lower(), "")
    if not custom_query and starter_img and starter_img != row["image_url"]:
        image_url = starter_img
    else:
        dict_res = await lookup_english_dictionary(row["word"]) if not custom_query else None
        image_url = await lookup_word_image(
            row["word"],
            part_of_speech=row["part_of_speech"],
            english_definition=(dict_res or {}).get("englishDefinition", ""),
            hint_query=custom_query,
            exclude_urls=[row["image_url"]] if row["image_url"] else None,
        )
    if image_url:
        _db_conn.execute("UPDATE words SET image_url = ? WHERE id = ?", (image_url, word_id))
        _db_conn.commit()
    return {"imageUrl": image_url}


@app.post("/api/words/import", status_code=201)
async def import_words(request: Request, user: JwtPayload = Depends(require_auth)) -> dict[str, Any]:
    body = await request.json()
    raw_content = str(body.get("rawContent") or "")
    if not raw_content.strip():
        raise HTTPException(status_code=400, detail="Вставьте список слов или загрузите файл")

    entries = parse_word_list_input(raw_content, body.get("format"))[:30]
    if not entries:
        raise HTTPException(status_code=400, detail="Не удалось распознать ни одного слова")

    target_deck_id = int(body["deckId"]) if body.get("deckId") else None
    if not target_deck_id and str(body.get("deckTitle") or "").strip():
        cur = _db_conn.execute(
            "INSERT INTO decks (user_id, title, description, category, cefr_level) VALUES (?, ?, 'Импортированный список слов', 'Импорт', 'B1')",
            (user["userId"], str(body["deckTitle"]).strip()),
        )
        _db_conn.commit()
        target_deck_id = int(cur.lastrowid)

    async def process_entry(entry: dict[str, Any]) -> dict[str, Any]:
        dict_res = await lookup_english_dictionary(entry["word"], entry.get("partOfSpeech") or "")
        pos = entry.get("partOfSpeech") or dict_res["partOfSpeech"] or "noun"
        starter_img = STARTER_WORD_IMAGES.get(entry["word"].lower())

        async def get_photo() -> str:
            if starter_img:
                return starter_img
            try:
                return await asyncio.wait_for(
                    lookup_word_image(
                        entry["word"],
                        part_of_speech=pos,
                        english_definition=dict_res["englishDefinition"],
                    ),
                    timeout=2.8,
                )
            except asyncio.TimeoutError:
                return ""

        if entry.get("translation") and entry.get("exampleEn") and entry.get("exampleRu"):
            photo_url = await get_photo()
            return {
                "word": entry["word"],
                "phonetic": dict_res["phonetic"],
                "partOfSpeech": pos,
                "translation": entry["translation"],
                "exampleEn": entry["exampleEn"],
                "exampleRu": entry["exampleRu"],
                "secondaryExampleEn": "",
                "secondaryExampleRu": "",
                "cefrLevel": "B1",
                "audioUrl": dict_res["audioUrl"],
                "imageUrl": photo_url,
            }

        enriched, photo_url = await asyncio.gather(
            enrich_vocabulary_word(entry["word"], dict_res, entry.get("translation"), pos),
            get_photo(),
        )
        return {
            "word": entry["word"],
            "phonetic": dict_res["phonetic"] or enriched["phonetic"],
            "partOfSpeech": entry.get("partOfSpeech") or enriched["partOfSpeech"],
            "translation": entry.get("translation") or enriched["translation"],
            "exampleEn": entry.get("exampleEn") or enriched["exampleEn"],
            "exampleRu": entry.get("exampleRu") or enriched["exampleRu"],
            "secondaryExampleEn": enriched["secondaryExampleEn"],
            "secondaryExampleRu": enriched["secondaryExampleRu"],
            "cefrLevel": enriched["cefrLevel"],
            "audioUrl": dict_res["audioUrl"],
            "imageUrl": photo_url,
        }

    enriched_items: list[dict[str, Any]] = []
    for i in range(0, len(entries), 5):
        chunk = entries[i : i + 5]
        enriched_items.extend(await asyncio.gather(*(process_entry(e) for e in chunk)))

    for item in enriched_items:
        _db_conn.execute(
            """
            INSERT INTO words (
              user_id, deck_id, word, phonetic, part_of_speech, translation,
              example_en, example_ru, secondary_example_en, secondary_example_ru,
              cefr_level, audio_url, image_url, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')
            """,
            (
                user["userId"], target_deck_id, item["word"], item["phonetic"], item["partOfSpeech"],
                item["translation"], item["exampleEn"], item["exampleRu"], item["secondaryExampleEn"],
                item["secondaryExampleRu"], item["cefrLevel"], item["audioUrl"], item["imageUrl"],
            ),
        )
    _db_conn.commit()
    award_user_xp(_db_conn, user["userId"], len(enriched_items) * 8, False)
    unlocked = await evaluate_and_unlock_achievements(_db_conn, user["userId"], _ws_hub)
    return {"importedCount": len(enriched_items), "deckId": target_deck_id, "unlockedAchievements": unlocked}


@app.delete("/api/words/{word_id}")
async def delete_word(word_id: int, user: JwtPayload = Depends(require_auth)) -> dict[str, bool]:
    word = _db_conn.execute("SELECT id, user_id FROM words WHERE id = ?", (word_id,)).fetchone()
    if not word:
        raise HTTPException(status_code=404, detail="Слово не найдено")
    if word["user_id"] != user["userId"] and user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Нет прав на удаление этого слова")
    _db_conn.execute("DELETE FROM words WHERE id = ?", (word_id,))
    _db_conn.commit()
    return {"ok": True}


# =========================================================================
# Spaced Repetition (FSRS)
# =========================================================================
@app.get("/api/study/queue")
async def study_queue(
    deckId: int | None = Query(None),
    mode: str = Query(""),
    user: JwtPayload = Depends(require_auth),
) -> dict[str, Any]:
    params: list[Any] = [user["userId"]]
    deck_sql = ""
    if deckId:
        deck_sql = " AND w.deck_id = ?"
        params.append(deckId)
    due_sql = "" if mode == "all" else " AND (w.next_review_at <= datetime('now') OR w.status = 'new')"

    rows = _db_conn.execute(
        f"""
        SELECT w.*, d.title AS deck_title
        FROM words w LEFT JOIN decks d ON d.id = w.deck_id
        WHERE w.user_id = ? {deck_sql} {due_sql}
        ORDER BY CASE w.status WHEN 'learning' THEN 0 WHEN 'new' THEN 1 WHEN 'review' THEN 2 ELSE 3 END,
                 w.next_review_at ASC
        LIMIT 30
        """,
        params,
    ).fetchall()

    now = datetime.now(timezone.utc)
    queue = []
    for row in rows:
        d = _row_to_dict(row)
        d["intervalPreviews"] = preview_all_fsrs_intervals(
            {
                "dueAt": d["next_review_at"],
                "stability": d["fsrs_stability"],
                "difficulty": d["fsrs_difficulty"],
                "state": d["fsrs_state"],
                "reps": d["repetitions"],
                "lapses": d["fsrs_lapses"],
                "learningSteps": d["fsrs_learning_steps"],
                "lastReviewedAt": d["last_reviewed_at"],
                "status": d["status"],
                "intervalDays": d["interval_days"],
            },
            now,
        )
        queue.append(d)
    return {"queue": queue, "totalDue": len(queue)}


@app.post("/api/study/review")
async def study_review(request: Request, user: JwtPayload = Depends(require_auth)) -> dict[str, Any]:
    body = await request.json()
    word_id = body.get("wordId")
    quality = int(body.get("quality") or 0)
    if not word_id or quality not in (1, 2, 3, 4):
        raise HTTPException(status_code=400, detail="Некорректные параметры оценки карточки")

    word = _db_conn.execute(
        "SELECT * FROM words WHERE id = ? AND user_id = ?", (int(word_id), user["userId"])
    ).fetchone()
    if not word:
        raise HTTPException(status_code=404, detail="Карточка не найдена")

    nxt = calculate_fsrs(
        {
            "dueAt": word["next_review_at"],
            "stability": word["fsrs_stability"],
            "difficulty": word["fsrs_difficulty"],
            "state": word["fsrs_state"],
            "reps": word["repetitions"],
            "lapses": word["fsrs_lapses"],
            "learningSteps": word["fsrs_learning_steps"],
            "lastReviewedAt": word["last_reviewed_at"],
            "status": word["status"],
            "intervalDays": word["interval_days"],
        },
        quality,  # type: ignore[arg-type]
    )
    xp_earned = 5 if quality == 1 else (10 if quality == 2 else (15 if quality == 3 else 20))

    _db_conn.execute(
        """
        UPDATE words
        SET ease_factor = ?, interval_days = ?, repetitions = ?, status = ?,
            fsrs_stability = ?, fsrs_difficulty = ?, fsrs_state = ?, fsrs_lapses = ?, fsrs_learning_steps = ?,
            next_review_at = ?, last_reviewed_at = datetime('now')
        WHERE id = ?
        """,
        (
            nxt["easeFactor"], nxt["intervalDays"], nxt["repetitions"], nxt["status"],
            nxt["stability"], nxt["difficulty"], nxt["state"], nxt["lapses"], nxt["learningSteps"],
            nxt["nextReviewAt"], word["id"],
        ),
    )
    _db_conn.execute(
        "INSERT INTO review_logs (user_id, word_id, quality, ease_factor_after, interval_after, xp_earned) VALUES (?, ?, ?, ?, ?, ?)",
        (user["userId"], word["id"], quality, nxt["easeFactor"], nxt["intervalDays"], xp_earned),
    )
    _db_conn.commit()

    stats = award_user_xp(_db_conn, user["userId"], xp_earned, True)
    unlocked = await evaluate_and_unlock_achievements(_db_conn, user["userId"], _ws_hub)
    await _ws_hub.broadcast_all("leaderboard:updated", {"userId": user["userId"], "xp": stats["xp"], "level": stats["level"]})
    return {"fsrs": nxt, "sm2": nxt, "xpEarned": xp_earned, "userStats": stats, "unlockedAchievements": unlocked}


# =========================================================================
# AI Practice & Translation
# =========================================================================
@app.post("/api/practice/check", status_code=201)
async def practice_check(request: Request, user: JwtPayload = Depends(require_auth)) -> dict[str, Any]:
    body = await request.json()
    clean_sentence = str(body.get("sentence") or "").strip()
    words_arr = [str(w).strip() for w in (body.get("targetWords") or []) if str(w).strip()]
    if len(clean_sentence) < 4:
        raise HTTPException(status_code=400, detail="Напишите предложение на английском языке")
    if not words_arr:
        raise HTTPException(status_code=400, detail="Выберите хотя бы одно целевое слово")

    try:
        if body.get("localFallback"):
            feedback = evaluate_locally_without_ai(
                "free", clean_sentence, words_arr, _load_user_word_hints(user["userId"], words_arr)
            )
        else:
            feedback = await evaluate_context_writing(words_arr, clean_sentence)
    except AiServiceError as err:
        return JSONResponse(status_code=err.status_code, content={"error": err.message, "code": err.code})
    except Exception as exc:
        err = to_friendly_ai_error(exc)
        return JSONResponse(status_code=err.status_code, content={"error": err.message, "code": err.code})

    xp_earned = 8 if not feedback["aiGenerated"] else (30 if feedback["grammarScore"] >= 85 else 15)
    cur = _db_conn.execute(
        """
        INSERT INTO writing_submissions (
          user_id, target_words, user_sentence, corrected_sentence,
          grammar_score, naturalness_score, is_correct, feedback_ru,
          grammar_notes_json, improved_variants_json, xp_earned
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            user["userId"], ", ".join(words_arr), clean_sentence, feedback["correctedSentence"],
            feedback["grammarScore"], feedback["naturalnessScore"], 1 if feedback["isCorrect"] else 0,
            feedback["feedbackRu"], json.dumps(feedback["grammarNotes"]),
            json.dumps(feedback["improvedVariants"]), xp_earned,
        ),
    )
    _db_conn.commit()
    stats = award_user_xp(_db_conn, user["userId"], xp_earned, True)
    unlocked = await evaluate_and_unlock_achievements(_db_conn, user["userId"], _ws_hub)
    return {"id": cur.lastrowid, "feedback": feedback, "xpEarned": xp_earned, "userStats": stats, "unlockedAchievements": unlocked}


@app.post("/api/practice/translation-prompt")
async def practice_translation_prompt(request: Request, user: JwtPayload = Depends(require_auth)) -> dict[str, Any]:
    body = await request.json()
    direction = "en_to_ru" if body.get("direction") == "en_to_ru" else "ru_to_en"
    words_arr = [str(w).strip() for w in (body.get("targetWords") or []) if str(w).strip()]
    if not words_arr:
        raise HTTPException(status_code=400, detail="Выберите хотя бы одно целевое слово из словаря")
    prompt = await generate_translation_prompt(words_arr, direction, _load_user_word_hints(user["userId"], words_arr))
    return {"prompt": prompt}


@app.post("/api/practice/translation-check", status_code=201)
async def practice_translation_check(request: Request, user: JwtPayload = Depends(require_auth)) -> dict[str, Any]:
    body = await request.json()
    direction = "en_to_ru" if body.get("direction") == "en_to_ru" else "ru_to_en"
    clean_source = str(body.get("sourceSentence") or "").strip()
    clean_user = str(body.get("userTranslation") or "").strip()
    words_arr = [str(w).strip() for w in (body.get("targetWords") or []) if str(w).strip()]
    if not clean_source or not clean_user:
        raise HTTPException(status_code=400, detail="Укажите исходное предложение и ваш перевод")

    try:
        if body.get("localFallback"):
            feedback = evaluate_locally_without_ai(
                direction, clean_user, words_arr, _load_user_word_hints(user["userId"], words_arr), clean_source
            )
        else:
            feedback = await evaluate_translation_attempt(direction, clean_source, clean_user, words_arr)
    except AiServiceError as err:
        return JSONResponse(status_code=err.status_code, content={"error": err.message, "code": err.code})
    except Exception as exc:
        err = to_friendly_ai_error(exc)
        return JSONResponse(status_code=err.status_code, content={"error": err.message, "code": err.code})

    xp_earned = 8 if not feedback["aiGenerated"] else (30 if feedback["grammarScore"] >= 85 else 18)
    label = f"[{'RU → EN' if direction == 'ru_to_en' else 'EN → RU'}] {', '.join(words_arr) or 'перевод'}"
    cur = _db_conn.execute(
        """
        INSERT INTO writing_submissions (
          user_id, target_words, user_sentence, corrected_sentence,
          grammar_score, naturalness_score, is_correct, feedback_ru,
          grammar_notes_json, improved_variants_json, xp_earned
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            user["userId"], label, f"{clean_source} → {clean_user}", feedback["correctedSentence"],
            feedback["grammarScore"], feedback["naturalnessScore"], 1 if feedback["isCorrect"] else 0,
            feedback["feedbackRu"], json.dumps(feedback["grammarNotes"]),
            json.dumps(feedback["improvedVariants"]), xp_earned,
        ),
    )
    _db_conn.commit()
    stats = award_user_xp(_db_conn, user["userId"], xp_earned, True)
    unlocked = await evaluate_and_unlock_achievements(_db_conn, user["userId"], _ws_hub)
    return {"id": cur.lastrowid, "feedback": feedback, "xpEarned": xp_earned, "userStats": stats, "unlockedAchievements": unlocked}


@app.get("/api/practice/history")
async def practice_history(user: JwtPayload = Depends(require_auth)) -> dict[str, Any]:
    rows = _db_conn.execute(
        "SELECT * FROM writing_submissions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20",
        (user["userId"],),
    ).fetchall()
    history = []
    for r in rows:
        d = _row_to_dict(r)
        d["grammarNotes"] = _safe_json_array(d.get("grammar_notes_json"))
        d["improvedVariants"] = _safe_json_array(d.get("improved_variants_json"))
        history.append(d)
    return {"history": history}


# =========================================================================
# Analytics & Reports
# =========================================================================
@app.get("/api/analytics/overview")
async def analytics_overview(user: JwtPayload = Depends(require_auth)) -> dict[str, Any]:
    uid = user["userId"]
    today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    counts = {"new": 0, "learning": 0, "review": 0, "mastered": 0}
    for r in _db_conn.execute("SELECT status, COUNT(*) AS cnt FROM words WHERE user_id = ? GROUP BY status", (uid,)).fetchall():
        counts[r["status"]] = r["cnt"]

    due_words = _db_conn.execute(
        "SELECT COUNT(*) AS cnt FROM words WHERE user_id = ? AND (next_review_at <= datetime('now') OR status = 'new')", (uid,)
    ).fetchone()["cnt"]
    today_reviews = _db_conn.execute(
        "SELECT COUNT(*) AS cnt FROM review_logs WHERE user_id = ? AND date(reviewed_at) = ?", (uid, today_str)
    ).fetchone()["cnt"]
    acc = _db_conn.execute(
        "SELECT COUNT(*) AS total, SUM(CASE WHEN quality >= 3 THEN 1 ELSE 0 END) AS passed FROM review_logs WHERE user_id = ?", (uid,)
    ).fetchone()
    accuracy_pct = round(((acc["passed"] or 0) / acc["total"]) * 100) if acc["total"] > 0 else 100
    avg_gram = _db_conn.execute(
        "SELECT COALESCE(ROUND(AVG(grammar_score)), 0) AS avg_score, COUNT(*) AS cnt FROM writing_submissions WHERE user_id = ?", (uid,)
    ).fetchone()

    daily_map = {
        r["day"]: _row_to_dict(r)
        for r in _db_conn.execute(
            """
            SELECT date(reviewed_at) AS day, COUNT(*) AS reviews,
                   SUM(CASE WHEN quality >= 3 THEN 1 ELSE 0 END) AS correct, SUM(xp_earned) AS xp
            FROM review_logs WHERE user_id = ? AND reviewed_at >= datetime('now', '-13 days')
            GROUP BY date(reviewed_at)
            """,
            (uid,),
        ).fetchall()
    }
    now = datetime.now(timezone.utc)
    velocity_14d = []
    for d in range(13, -1, -1):
        ds = (now - timedelta(days=d)).strftime("%Y-%m-%d")
        f = daily_map.get(ds, {})
        velocity_14d.append({
            "day": ds,
            "label": ds[5:].replace("-", "."),
            "reviews": f.get("reviews", 0),
            "correct": f.get("correct", 0),
            "xp": f.get("xp", 0),
        })

    heat_map = {
        r["day"]: r["cnt"]
        for r in _db_conn.execute(
            "SELECT date(reviewed_at) AS day, COUNT(*) AS cnt FROM review_logs WHERE user_id = ? AND reviewed_at >= datetime('now', '-83 days') GROUP BY date(reviewed_at)",
            (uid,),
        ).fetchall()
    }
    heatmap_84d = [
        {"day": (now - timedelta(days=d)).strftime("%Y-%m-%d"), "count": heat_map.get((now - timedelta(days=d)).strftime("%Y-%m-%d"), 0)}
        for d in range(83, -1, -1)
    ]

    hardest = _db_conn.execute(
        """
        SELECT id, word, translation, ease_factor, fsrs_difficulty, fsrs_stability, fsrs_lapses, repetitions, status
        FROM words WHERE user_id = ?
        ORDER BY CASE WHEN fsrs_difficulty > 0 THEN fsrs_difficulty ELSE 5.0 END DESC, fsrs_lapses DESC, ease_factor ASC
        LIMIT 5
        """,
        (uid,),
    ).fetchall()
    urow = _db_conn.execute("SELECT daily_goal, streak_days, xp, level FROM users WHERE id = ?", (uid,)).fetchone()
    return {
        "summary": {
            "totalWords": sum(counts.values()),
            "newWords": counts["new"],
            "learningWords": counts["learning"],
            "reviewWords": counts["review"],
            "masteredWords": counts["mastered"],
            "dueWords": due_words,
            "todayReviews": today_reviews,
            "dailyGoal": urow["daily_goal"] if urow else 15,
            "streakDays": urow["streak_days"] if urow else 0,
            "xp": urow["xp"] if urow else 0,
            "level": urow["level"] if urow else 1,
            "accuracyPercent": accuracy_pct,
            "totalReviews": acc["total"],
            "avgGrammarScore": avg_gram["avg_score"],
            "writingCount": avg_gram["cnt"],
        },
        "velocity14d": velocity_14d,
        "heatmap84d": heatmap_84d,
        "hardestWords": [_row_to_dict(r) for r in hardest],
    }


@app.get("/api/analytics/reports")
async def analytics_reports(user: JwtPayload = Depends(require_auth)) -> dict[str, Any]:
    rows = _db_conn.execute(
        "SELECT * FROM ai_reports WHERE user_id = ? ORDER BY created_at DESC LIMIT 10", (user["userId"],)
    ).fetchall()
    return {
        "reports": [
            {
                "id": r["id"],
                "title": r["title"],
                "summaryRu": r["summary_ru"],
                "strengths": _safe_json_array(r["strengths_json"]),
                "focusAreas": _safe_json_array(r["focus_areas_json"]),
                "actionPlan": _safe_json_array(r["action_plan_json"]),
                "predictedMilestone": r["predicted_milestone"],
                "createdAt": r["created_at"],
            }
            for r in rows
        ]
    }


@app.post("/api/analytics/reports", status_code=201)
async def create_analytics_report(user: JwtPayload = Depends(require_auth)) -> dict[str, Any]:
    uid = user["userId"]
    u = _db_conn.execute("SELECT name, level, xp, streak_days FROM users WHERE id = ?", (uid,)).fetchone()
    total_words = _db_conn.execute("SELECT COUNT(*) AS cnt FROM words WHERE user_id = ?", (uid,)).fetchone()["cnt"]
    mastered = _db_conn.execute("SELECT COUNT(*) AS cnt FROM words WHERE user_id = ? AND status = 'mastered'", (uid,)).fetchone()["cnt"]
    learning = _db_conn.execute("SELECT COUNT(*) AS cnt FROM words WHERE user_id = ? AND status IN ('learning', 'review')", (uid,)).fetchone()["cnt"]
    due = _db_conn.execute("SELECT COUNT(*) AS cnt FROM words WHERE user_id = ? AND (next_review_at <= datetime('now') OR status = 'new')", (uid,)).fetchone()["cnt"]
    rev = _db_conn.execute("SELECT COUNT(*) AS cnt, SUM(CASE WHEN quality >= 3 THEN 1 ELSE 0 END) AS passed FROM review_logs WHERE user_id = ? AND reviewed_at >= datetime('now', '-14 days')", (uid,)).fetchone()
    avg_gram = _db_conn.execute("SELECT COALESCE(ROUND(AVG(grammar_score)), 0) AS s FROM writing_submissions WHERE user_id = ?", (uid,)).fetchone()["s"]
    hardest = _db_conn.execute("SELECT word, translation, ease_factor AS easeFactor FROM words WHERE user_id = ? ORDER BY ease_factor ASC LIMIT 5", (uid,)).fetchall()
    topics = _db_conn.execute("SELECT DISTINCT category FROM decks WHERE user_id = ? OR is_curated = 1 LIMIT 5", (uid,)).fetchall()

    try:
        report = await generate_learning_report({
            "userName": u["name"],
            "level": u["level"],
            "xp": u["xp"],
            "streakDays": u["streak_days"],
            "totalWords": total_words,
            "masteredWords": mastered,
            "learningWords": learning,
            "dueWords": due,
            "reviewsLast14Days": rev["cnt"],
            "accuracyPercent": round(((rev["passed"] or 0) / rev["cnt"]) * 100) if rev["cnt"] > 0 else 100,
            "avgGrammarScore": avg_gram,
            "hardestWords": [_row_to_dict(r) for r in hardest],
            "recentTopics": [t["category"] for t in topics],
        })
    except AiServiceError as err:
        return JSONResponse(status_code=err.status_code, content={"error": err.message, "code": err.code})
    except Exception as exc:
        err = to_friendly_ai_error(exc)
        return JSONResponse(status_code=err.status_code, content={"error": err.message, "code": err.code})

    cur = _db_conn.execute(
        "INSERT INTO ai_reports (user_id, title, summary_ru, strengths_json, focus_areas_json, action_plan_json, predicted_milestone) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (uid, report["title"], report["summaryRu"], json.dumps(report["strengths"]), json.dumps(report["focusAreas"]), json.dumps(report["actionPlan"]), report["predictedMilestone"]),
    )
    _db_conn.commit()
    return {"report": {"id": cur.lastrowid, **report, "createdAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}}


# =========================================================================
# Gamification, Notifications & Admin
# =========================================================================
@app.get("/api/gamification/leaderboard")
async def leaderboard(user: JwtPayload = Depends(require_auth)) -> dict[str, Any]:
    rows = _db_conn.execute(
        """
        SELECT u.id, u.name, u.xp, u.level, u.streak_days, u.avatar_url,
          (SELECT COUNT(*) FROM words w WHERE w.user_id = u.id AND w.status = 'mastered') AS mastered_count,
          (SELECT COUNT(*) FROM user_achievements ua WHERE ua.user_id = u.id) AS achievements_count
        FROM users u WHERE u.is_active = 1
        ORDER BY u.xp DESC, u.streak_days DESC LIMIT 25
        """
    ).fetchall()
    return {"leaderboard": [_row_to_dict(r) for r in rows], "currentUserId": user["userId"]}


@app.get("/api/gamification/achievements")
async def achievements(user: JwtPayload = Depends(require_auth)) -> dict[str, Any]:
    rows = _db_conn.execute(
        """
        SELECT a.*, ua.unlocked_at FROM achievements a
        LEFT JOIN user_achievements ua ON ua.achievement_id = a.id AND ua.user_id = ?
        ORDER BY CASE WHEN ua.unlocked_at IS NOT NULL THEN 0 ELSE 1 END, a.id ASC
        """,
        (user["userId"],),
    ).fetchall()
    return {"achievements": [_row_to_dict(r) for r in rows]}


@app.get("/api/notifications")
async def get_notifications(user: JwtPayload = Depends(require_auth)) -> dict[str, Any]:
    rows = _db_conn.execute(
        "SELECT * FROM notifications WHERE user_id = ? OR user_id IS NULL ORDER BY created_at DESC, id DESC LIMIT 30",
        (user["userId"],),
    ).fetchall()
    return {"notifications": [_row_to_dict(r) for r in rows]}


@app.post("/api/notifications/{notif_id}/read")
async def read_notification(notif_id: int, user: JwtPayload = Depends(require_auth)) -> dict[str, bool]:
    _db_conn.execute(
        "UPDATE notifications SET is_read = 1 WHERE id = ? AND (user_id = ? OR user_id IS NULL)",
        (notif_id, user["userId"]),
    )
    _db_conn.commit()
    return {"ok": True}


@app.post("/api/notifications/read-all")
async def read_all_notifications(user: JwtPayload = Depends(require_auth)) -> dict[str, bool]:
    _db_conn.execute("UPDATE notifications SET is_read = 1 WHERE user_id = ?", (user["userId"],))
    _db_conn.commit()
    return {"ok": True}


@app.put("/api/notifications/settings")
async def update_notification_settings(request: Request, user: JwtPayload = Depends(require_auth)) -> dict[str, Any]:
    body = await request.json()
    try:
        goal = max(5, min(200, round(float(body.get("dailyGoal", 15)))))
    except Exception:
        goal = 15
    enabled = 1 if body.get("reminderEnabled") else 0
    rt = str(body.get("reminderTime") or "")
    reminder_time = rt if re.match(r"^\d{2}:\d{2}$", rt) else "19:00"
    _db_conn.execute(
        "UPDATE users SET daily_goal = ?, reminder_enabled = ?, reminder_time = ? WHERE id = ?",
        (goal, enabled, reminder_time, user["userId"]),
    )
    _db_conn.commit()
    row = _db_conn.execute("SELECT * FROM users WHERE id = ?", (user["userId"],)).fetchone()
    return {"user": _sanitize_user(row)}


@app.post("/api/notifications/test-reminder")
async def test_reminder(user: JwtPayload = Depends(require_auth)) -> dict[str, Any]:
    uid = user["userId"]
    due_cnt = _db_conn.execute(
        "SELECT COUNT(*) AS cnt FROM words WHERE user_id = ? AND (next_review_at <= datetime('now') OR status = 'new')", (uid,)
    ).fetchone()["cnt"]
    title = "Напоминание о практике"
    msg = (
        f"Сейчас к интервальному повторению готово карточек: {due_cnt}. Посвятите 5 минут повторению!"
        if due_cnt > 0
        else "Дневная норма выполнена! Закрепите слова через ИИ-практику предложений."
    )
    cur = _db_conn.execute("INSERT INTO notifications (user_id, type, title, message) VALUES (?, 'reminder', ?, ?)", (uid, title, msg))
    _db_conn.commit()
    notif = {
        "id": cur.lastrowid,
        "user_id": uid,
        "type": "reminder",
        "title": title,
        "message": msg,
        "is_read": 0,
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    await _ws_hub.send_to_user(uid, "reminder:due", notif)
    return {"notification": notif}


@app.get("/api/admin/overview")
async def admin_overview(_admin: JwtPayload = Depends(require_admin)) -> dict[str, Any]:
    t0 = time.perf_counter()
    stats = {
        "totalUsers": _db_conn.execute("SELECT COUNT(*) AS cnt FROM users").fetchone()["cnt"],
        "activeUsers": _db_conn.execute("SELECT COUNT(*) AS cnt FROM users WHERE is_active = 1").fetchone()["cnt"],
        "totalWords": _db_conn.execute("SELECT COUNT(*) AS cnt FROM words").fetchone()["cnt"],
        "totalReviews": _db_conn.execute("SELECT COUNT(*) AS cnt FROM review_logs").fetchone()["cnt"],
        "totalWritings": _db_conn.execute("SELECT COUNT(*) AS cnt FROM writing_submissions").fetchone()["cnt"],
        "totalDecks": _db_conn.execute("SELECT COUNT(*) AS cnt FROM decks").fetchone()["cnt"],
        "queryLatencyMs": round((time.perf_counter() - t0) * 1000, 2),
        "onlineWsClients": _ws_hub.get_online_count(),
    }
    return {"stats": stats}


@app.get("/api/admin/users")
async def admin_users(_admin: JwtPayload = Depends(require_admin)) -> dict[str, Any]:
    rows = _db_conn.execute(
        """
        SELECT u.id, u.email, u.name, u.role, u.oauth_provider, u.xp, u.level, u.streak_days, u.is_active, u.created_at,
          (SELECT COUNT(*) FROM words w WHERE w.user_id = u.id) AS words_count,
          (SELECT COUNT(*) FROM review_logs r WHERE r.user_id = u.id) AS reviews_count
        FROM users u ORDER BY u.created_at DESC
        """
    ).fetchall()
    return {"users": [_row_to_dict(r) for r in rows]}


@app.patch("/api/admin/users/{target_id}")
async def admin_patch_user(
    target_id: int, request: Request, admin: JwtPayload = Depends(require_admin)
) -> dict[str, Any]:
    body = await request.json()
    if target_id == admin["userId"] and body.get("isActive") is False:
        raise HTTPException(status_code=400, detail="Нельзя деактивировать собственный аккаунт администратора")
    existing = _db_conn.execute("SELECT id, role, is_active FROM users WHERE id = ?", (target_id,)).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    next_role = body.get("role") if body.get("role") in ("admin", "user") else existing["role"]
    next_active = (1 if body.get("isActive") else 0) if isinstance(body.get("isActive"), bool) else existing["is_active"]
    _db_conn.execute("UPDATE users SET role = ?, is_active = ? WHERE id = ?", (next_role, next_active, target_id))
    _db_conn.commit()
    updated = _db_conn.execute(
        "SELECT id, email, name, role, xp, level, streak_days, is_active, created_at FROM users WHERE id = ?",
        (target_id,),
    ).fetchone()
    return {"user": _row_to_dict(updated)}


@app.get("/api/admin/content")
async def admin_content(_admin: JwtPayload = Depends(require_admin)) -> dict[str, Any]:
    curated = _db_conn.execute("SELECT * FROM decks WHERE is_curated = 1 ORDER BY id DESC").fetchall()
    recent = _db_conn.execute(
        """
        SELECT w.id, w.word, w.translation, w.cefr_level, w.status, u.name AS owner_name, d.title AS deck_title
        FROM words w LEFT JOIN users u ON u.id = w.user_id LEFT JOIN decks d ON d.id = w.deck_id
        ORDER BY w.id DESC LIMIT 50
        """
    ).fetchall()
    return {"curatedDecks": [_row_to_dict(r) for r in curated], "recentWords": [_row_to_dict(r) for r in recent]}


@app.post("/api/admin/curated-deck", status_code=201)
async def admin_curated_deck(request: Request, admin: JwtPayload = Depends(require_admin)) -> dict[str, Any]:
    body = await request.json()
    title = str(body.get("title") or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="Введите название системной колоды")
    cur = _db_conn.execute(
        "INSERT INTO decks (user_id, title, description, category, cefr_level, is_curated) VALUES (?, ?, ?, ?, ?, 1)",
        (admin["userId"], title, str(body.get("description") or "").strip(), str(body.get("category") or "Подборка редакции").strip(), str(body.get("cefrLevel") or "B1").strip()),
    )
    _db_conn.commit()
    deck = _db_conn.execute("SELECT * FROM decks WHERE id = ?", (cur.lastrowid,)).fetchone()
    return {"deck": _row_to_dict(deck)}


@app.post("/api/admin/broadcast", status_code=201)
async def admin_broadcast(request: Request, _admin: JwtPayload = Depends(require_admin)) -> dict[str, Any]:
    body = await request.json()
    title = str(body.get("title") or "").strip()
    message = str(body.get("message") or "").strip()
    if not title or not message:
        raise HTTPException(status_code=400, detail="Заголовок и текст уведомления обязательны")
    cur = _db_conn.execute(
        "INSERT INTO notifications (user_id, type, title, message) VALUES (NULL, 'system', ?, ?)",
        (title, message),
    )
    _db_conn.commit()
    payload = {
        "id": cur.lastrowid,
        "user_id": None,
        "type": "system",
        "title": title,
        "message": message,
        "is_read": 0,
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    await _ws_hub.broadcast_all("admin:broadcast", payload)
    return {"notification": payload, "deliveredOnline": _ws_hub.get_online_count()}


# =========================================================================
# WebSocket Notifications & Static Frontend Serving
# =========================================================================
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket, token: str = Query("")) -> None:
    payload = verify_jwt(token) if token else None
    if not payload:
        await ws.close(code=4001)
        return

    uid = payload["userId"]
    await ws.accept()
    _ws_hub.register(uid, ws)
    try:
        await _ws_hub.send_to_user(uid, "connected", {"userId": uid, "onlineUsers": _ws_hub.get_online_count()})
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        _ws_hub.unregister(uid, ws)


_DIST_DIR = Path(__file__).resolve().parent.parent / "dist"
if _DIST_DIR.is_dir():
    _assets_dir = _DIST_DIR / "assets"
    if _assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=str(_assets_dir)), name="assets")

    @app.get("/{full_path:path}")
    async def spa_fallback(full_path: str) -> Response:
        if full_path.startswith("api/") or full_path == "ws":
            raise HTTPException(status_code=404, detail="Маршрут не найден")
        candidate = _DIST_DIR / full_path
        if full_path and candidate.is_file():
            return FileResponse(str(candidate))
        return FileResponse(str(_DIST_DIR / "index.html"))

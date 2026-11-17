from __future__ import annotations

import os
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from auth import get_canonical_email, hash_password
from curated_catalog import (
    CURATED_DECKS_CATALOG,
    STARTER_WORD_IMAGES,
    get_curated_decks_for_level,
    normalize_cefr_level,
)

DEFAULT_DB_PATH = str(Path(__file__).resolve().parent.parent / "data" / "lexiforge.db")


def get_db_path() -> str:
    return os.getenv("DATABASE_PATH", DEFAULT_DB_PATH)


def open_db(db_path: str | None = None) -> sqlite3.Connection:
    resolved = db_path or get_db_path()
    if resolved != ":memory:":
        Path(resolved).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(resolved, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA temp_store = MEMORY")
    conn.execute("PRAGMA cache_size = -32000")
    return conn


def init_database(db_path: str | None = None) -> sqlite3.Connection:
    conn = open_db(db_path)

    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT NOT NULL UNIQUE,
          canonical_email TEXT,
          name TEXT NOT NULL,
          password_hash TEXT,
          role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'admin')),
          oauth_provider TEXT,
          oauth_id TEXT,
          avatar_url TEXT,
          xp INTEGER NOT NULL DEFAULT 0,
          level INTEGER NOT NULL DEFAULT 1,
          streak_days INTEGER NOT NULL DEFAULT 0,
          last_study_date TEXT,
          daily_goal INTEGER NOT NULL DEFAULT 15,
          reminder_enabled INTEGER NOT NULL DEFAULT 1,
          reminder_time TEXT NOT NULL DEFAULT '19:00',
          cefr_level TEXT NOT NULL DEFAULT 'A2',
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS decks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          category TEXT NOT NULL DEFAULT 'Общая лексика',
          cefr_level TEXT NOT NULL DEFAULT 'B1',
          is_curated INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS words (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          deck_id INTEGER REFERENCES decks(id) ON DELETE SET NULL,
          word TEXT NOT NULL,
          phonetic TEXT NOT NULL DEFAULT '',
          part_of_speech TEXT NOT NULL DEFAULT 'noun',
          translation TEXT NOT NULL,
          example_en TEXT NOT NULL,
          example_ru TEXT NOT NULL,
          secondary_example_en TEXT NOT NULL DEFAULT '',
          secondary_example_ru TEXT NOT NULL DEFAULT '',
          cefr_level TEXT NOT NULL DEFAULT 'B1',
          audio_url TEXT NOT NULL DEFAULT '',
          image_url TEXT NOT NULL DEFAULT '',
          ease_factor REAL NOT NULL DEFAULT 2.5,
          interval_days REAL NOT NULL DEFAULT 0,
          repetitions INTEGER NOT NULL DEFAULT 0,
          fsrs_stability REAL NOT NULL DEFAULT 0,
          fsrs_difficulty REAL NOT NULL DEFAULT 0,
          fsrs_state INTEGER NOT NULL DEFAULT 0,
          fsrs_lapses INTEGER NOT NULL DEFAULT 0,
          fsrs_learning_steps INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new', 'learning', 'review', 'mastered')),
          next_review_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_reviewed_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS review_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
          quality INTEGER NOT NULL CHECK(quality BETWEEN 1 AND 4),
          ease_factor_after REAL NOT NULL,
          interval_after REAL NOT NULL,
          xp_earned INTEGER NOT NULL DEFAULT 10,
          reviewed_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS writing_submissions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          target_words TEXT NOT NULL,
          user_sentence TEXT NOT NULL,
          corrected_sentence TEXT NOT NULL,
          grammar_score INTEGER NOT NULL,
          naturalness_score INTEGER NOT NULL,
          is_correct INTEGER NOT NULL,
          feedback_ru TEXT NOT NULL,
          grammar_notes_json TEXT NOT NULL DEFAULT '[]',
          improved_variants_json TEXT NOT NULL DEFAULT '[]',
          xp_earned INTEGER NOT NULL DEFAULT 15,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS achievements (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          code TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          icon TEXT NOT NULL,
          xp_reward INTEGER NOT NULL DEFAULT 50,
          threshold INTEGER NOT NULL DEFAULT 1,
          category TEXT NOT NULL DEFAULT 'learning'
        );

        CREATE TABLE IF NOT EXISTS user_achievements (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          achievement_id INTEGER NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
          unlocked_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(user_id, achievement_id)
        );

        CREATE TABLE IF NOT EXISTS notifications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          type TEXT NOT NULL DEFAULT 'info',
          title TEXT NOT NULL,
          message TEXT NOT NULL,
          is_read INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS ai_reports (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          summary_ru TEXT NOT NULL,
          strengths_json TEXT NOT NULL,
          focus_areas_json TEXT NOT NULL,
          action_plan_json TEXT NOT NULL,
          predicted_milestone TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_words_user_due ON words(user_id, next_review_at);
        CREATE INDEX IF NOT EXISTS idx_words_user_status ON words(user_id, status);
        CREATE INDEX IF NOT EXISTS idx_words_deck ON words(deck_id);
        CREATE INDEX IF NOT EXISTS idx_review_logs_user_date ON review_logs(user_id, reviewed_at);
        CREATE INDEX IF NOT EXISTS idx_writing_user_date ON writing_submissions(user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, is_read, created_at);
        CREATE INDEX IF NOT EXISTS idx_users_xp ON users(xp DESC);
        """
    )

    user_cols = {r["name"] for r in conn.execute("PRAGMA table_info(users)").fetchall()}
    if "canonical_email" not in user_cols:
        conn.execute("ALTER TABLE users ADD COLUMN canonical_email TEXT")
    if "cefr_level" not in user_cols:
        conn.execute("ALTER TABLE users ADD COLUMN cefr_level TEXT NOT NULL DEFAULT 'A2'")

    word_cols = {r["name"] for r in conn.execute("PRAGMA table_info(words)").fetchall()}
    for col, ddl in (
        ("image_url", "ALTER TABLE words ADD COLUMN image_url TEXT NOT NULL DEFAULT ''"),
        ("fsrs_stability", "ALTER TABLE words ADD COLUMN fsrs_stability REAL NOT NULL DEFAULT 0"),
        ("fsrs_difficulty", "ALTER TABLE words ADD COLUMN fsrs_difficulty REAL NOT NULL DEFAULT 0"),
        ("fsrs_state", "ALTER TABLE words ADD COLUMN fsrs_state INTEGER NOT NULL DEFAULT 0"),
        ("fsrs_lapses", "ALTER TABLE words ADD COLUMN fsrs_lapses INTEGER NOT NULL DEFAULT 0"),
        ("fsrs_learning_steps", "ALTER TABLE words ADD COLUMN fsrs_learning_steps INTEGER NOT NULL DEFAULT 0"),
    ):
        if col not in word_cols:
            conn.execute(ddl)

    conn.execute(
        """
        UPDATE words
        SET fsrs_stability = CASE WHEN interval_days > 0 THEN interval_days ELSE 1 END,
            fsrs_difficulty = 5.0,
            fsrs_state = CASE WHEN status = 'learning' THEN 1 ELSE 2 END
        WHERE repetitions > 0 AND fsrs_state = 0
        """
    )

    missing_canonical = conn.execute(
        "SELECT id, email FROM users WHERE canonical_email IS NULL OR canonical_email = ''"
    ).fetchall()
    for row in missing_canonical:
        conn.execute(
            "UPDATE users SET canonical_email = ? WHERE id = ?",
            (get_canonical_email(row["email"]), row["id"]),
        )

    conn.executescript(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users(lower(trim(email)));
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_canonical_email ON users(canonical_email) WHERE canonical_email IS NOT NULL;
        """
    )
    conn.commit()

    seed_initial_data(conn)
    ensure_curated_catalog_and_images(conn)
    return conn


def seed_starter_words_for_level(
    conn: sqlite3.Connection,
    user_id: int,
    raw_level: object,
) -> dict[str, int]:
    level = normalize_cefr_level(raw_level)
    primary_spec = get_curated_decks_for_level(level)[0]

    existing_curated = conn.execute(
        "SELECT id FROM decks WHERE is_curated = 1 AND lower(title) = lower(?)",
        (primary_spec["title"],),
    ).fetchone()

    if existing_curated:
        target_deck_id = int(existing_curated["id"])
    else:
        cur = conn.execute(
            "INSERT INTO decks (user_id, title, description, category, cefr_level, is_curated) VALUES (?, ?, ?, ?, ?, 0)",
            (
                user_id,
                primary_spec["title"],
                primary_spec["description"],
                primary_spec["category"],
                primary_spec["cefrLevel"],
            ),
        )
        target_deck_id = int(cur.lastrowid)

    added_count = 0
    for w in primary_spec["words"]:
        cur = conn.execute(
            """
            INSERT INTO words (
              user_id, deck_id, word, phonetic, part_of_speech, translation,
              example_en, example_ru, secondary_example_en, secondary_example_ru,
              cefr_level, image_url, status
            )
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new'
            WHERE NOT EXISTS (SELECT 1 FROM words WHERE user_id = ? AND lower(word) = lower(?))
            """,
            (
                user_id,
                target_deck_id,
                w["word"],
                w["phonetic"],
                w["partOfSpeech"],
                w["translation"],
                w["exampleEn"],
                w["exampleRu"],
                w["secondaryExampleEn"],
                w["secondaryExampleRu"],
                w["cefrLevel"],
                w["imageUrl"],
                user_id,
                w["word"],
            ),
        )
        if cur.rowcount > 0:
            added_count += 1

    due_iso = (datetime.now(timezone.utc) - timedelta(seconds=60)).isoformat().replace("+00:00", "Z")
    conn.execute("UPDATE words SET next_review_at = ? WHERE user_id = ?", (due_iso, user_id))
    conn.commit()
    return {"deckId": target_deck_id, "addedCount": added_count}


def ensure_curated_catalog_and_images(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        """
        SELECT id, word FROM words
        WHERE image_url IS NULL OR image_url = ''
           OR image_url LIKE '%Sauk_Indian_family%'
           OR image_url LIKE '%Best_friends_%'
           OR image_url LIKE '%Cooking_contest%'
           OR image_url LIKE '%Sturminster_Marshall%'
           OR image_url LIKE '%Lower_Manhattan_from_Governors_Island%'
           OR image_url LIKE '%Knossos_silver_coin%'
           OR image_url LIKE '%b96cae62-cebc-4db7-bb68-f17c10ff1420%'
           OR image_url LIKE '%Milwaukee_Central_Library%'
           OR image_url LIKE '%Hampton_Forest_Apartments%'
           OR image_url LIKE '%Aerial_wiew_of_Los_Angeles%'
           OR image_url LIKE '%Golden_Gate_Bridge%'
           OR image_url LIKE '%Hermandad_-_friendship%'
           OR image_url LIKE '%Reijiro_Wakatsuki%'
           OR image_url LIKE '%2016_Busola%'
           OR image_url LIKE '%Pushing_van_together%'
           OR image_url LIKE '%Quercus_robur%'
        """
    ).fetchall()
    for row in rows:
        match = STARTER_WORD_IMAGES.get(str(row["word"]).strip().lower())
        if match:
            conn.execute("UPDATE words SET image_url = ? WHERE id = ?", (match, row["id"]))

    admin_row = conn.execute(
        "SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1"
    ).fetchone()
    if not admin_row:
        conn.commit()
        return
    owner_id = int(admin_row["id"])

    for spec in CURATED_DECKS_CATALOG:
        existing_deck = conn.execute(
            "SELECT id FROM decks WHERE is_curated = 1 AND lower(title) = lower(?)",
            (spec["title"],),
        ).fetchone()
        if existing_deck:
            deck_id = int(existing_deck["id"])
        else:
            cur = conn.execute(
                "INSERT INTO decks (user_id, title, description, category, cefr_level, is_curated) VALUES (?, ?, ?, ?, ?, 1)",
                (owner_id, spec["title"], spec["description"], spec["category"], spec["cefrLevel"]),
            )
            deck_id = int(cur.lastrowid)

        cnt = conn.execute(
            "SELECT COUNT(*) AS cnt FROM words WHERE deck_id = ?", (deck_id,)
        ).fetchone()["cnt"]
        if cnt == 0:
            for w in spec["words"]:
                conn.execute(
                    """
                    INSERT INTO words (
                      user_id, deck_id, word, phonetic, part_of_speech, translation,
                      example_en, example_ru, secondary_example_en, secondary_example_ru,
                      cefr_level, image_url, status
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')
                    """,
                    (
                        owner_id,
                        deck_id,
                        w["word"],
                        w["phonetic"],
                        w["partOfSpeech"],
                        w["translation"],
                        w["exampleEn"],
                        w["exampleRu"],
                        w["secondaryExampleEn"],
                        w["secondaryExampleRu"],
                        w["cefrLevel"],
                        w["imageUrl"],
                    ),
                )
    conn.commit()


def seed_initial_data(conn: sqlite3.Connection) -> None:
    cnt_ach = conn.execute("SELECT COUNT(*) AS cnt FROM achievements").fetchone()["cnt"]
    if cnt_ach == 0:
        achievements = [
            ("first_word", "Первый шаг", "Добавьте свое первое английское слово в словарь", "BookOpen", 30, 1, "vocabulary"),
            ("vocab_20", "Собиратель лексики", "Соберите 20 слов в личном словаре", "Layers", 75, 20, "vocabulary"),
            ("first_review", "Начало интервалов", "Завершите первое повторение карточки по FSRS", "Sparkles", 25, 1, "study"),
            ("streak_7", "Неделя дисциплины", "Поддерживайте серию занятий 7 дней подряд", "Flame", 150, 7, "streak"),
            ("master_5", "Уверенное владение", "Доведите 5 слов до статуса «Выучено»", "Award", 120, 5, "mastery"),
            ("writer_5", "Мастер контекста", "Проверьте 5 предложений с новой лексикой у ИИ-наставника", "PenTool", 100, 5, "writing"),
            ("grammar_90", "Безупречная грамматика", "Получите оценку грамматики 90+ баллов от ИИ", "CheckCircle2", 80, 90, "writing"),
        ]
        conn.executemany(
            "INSERT INTO achievements (code, title, description, icon, xp_reward, threshold, category) VALUES (?, ?, ?, ?, ?, ?, ?)",
            achievements,
        )
    else:
        conn.execute(
            "UPDATE achievements SET description = 'Завершите первое повторение карточки по FSRS' WHERE code = 'first_review'"
        )

    cnt_users = conn.execute("SELECT COUNT(*) AS cnt FROM users").fetchone()["cnt"]
    if cnt_users > 0:
        conn.commit()
        return

    pw_hash = hash_password("Nekajon1608")
    today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    learner_cur = conn.execute(
        """
        INSERT INTO users (email, canonical_email, name, password_hash, role, xp, level, streak_days, last_study_date, daily_goal, reminder_enabled, reminder_time)
        VALUES (?, ?, ?, ?, 'user', 0, 1, 0, NULL, 15, 1, '19:00')
        """,
        ("learner@lexiforge.io", get_canonical_email("learner@lexiforge.io"), "neka", pw_hash),
    )
    learner_id = int(learner_cur.lastrowid)

    admin_cur = conn.execute(
        """
        INSERT INTO users (email, canonical_email, name, password_hash, role, xp, level, streak_days, last_study_date, daily_goal, reminder_enabled, reminder_time)
        VALUES (?, ?, ?, ?, 'admin', 1280, 13, 14, ?, 20, 1, '20:00')
        """,
        ("admin@lexiforge.io", get_canonical_email("admin@lexiforge.io"), "nekaadmin", pw_hash, today_str),
    )
    admin_id = int(admin_cur.lastrowid)

    personal_cur = conn.execute(
        """
        INSERT INTO users (email, canonical_email, name, password_hash, role, xp, level, streak_days, last_study_date, daily_goal, reminder_enabled, reminder_time)
        VALUES (?, ?, ?, ?, 'user', 0, 1, 0, NULL, 15, 1, '19:00')
        """,
        ("nekajon.nekka@gmail.com", get_canonical_email("nekajon.nekka@gmail.com"), "nekajon", pw_hash),
    )
    personal_id = int(personal_cur.lastrowid)

    deck1 = int(
        conn.execute(
            "INSERT INTO decks (user_id, title, description, category, cefr_level, is_curated) VALUES (?, ?, ?, ?, 'A2', 1)",
            (learner_id, "Повседневный английский (A2)", "Базовые глаголы и прилагательные для общения каждый день.", "Повседневное"),
        ).lastrowid
    )
    deck2 = int(
        conn.execute(
            "INSERT INTO decks (user_id, title, description, category, cefr_level, is_curated) VALUES (?, ?, ?, ?, 'B1', 1)",
            (learner_id, "Работа, поездки и планы (B1)", "Полезные слова среднего уровня для работы, путешествий и переписки.", "Общение"),
        ).lastrowid
    )
    deck3 = int(
        conn.execute(
            "INSERT INTO decks (user_id, title, description, category, cefr_level, is_curated) VALUES (?, ?, ?, ?, 'B1', 1)",
            (admin_id, "Полезные фразы (A2–B1)", "Частые фразовые глаголы, которые легко использовать в речи.", "Разговорный"),
        ).lastrowid
    )

    starter_words = [
        (deck1, "improve", "/ɪmˈpruːv/", "verb", "улучшать, совершенствовать", "I read English articles every morning to improve my vocabulary.", "Я читаю статьи на английском каждое утро, чтобы улучшить свой словарный запас.", "The weather started to improve in the afternoon.", "Днём погода начала улучшаться.", "A2"),
        (deck1, "schedule", "/ˈskedʒ.uːl/", "noun", "расписание, график", "My work schedule is very busy on Mondays.", "Мой рабочий график очень плотный по понедельникам.", "We are right on schedule for the train.", "Мы идём точно по расписанию к поезду.", "A2"),
        (deck1, "decide", "/dɪˈsaɪd/", "verb", "решать, принимать решение", "We need to decide where to go on vacation this summer.", "Нам нужно решить, куда поехать в отпуск этим летом.", "She decided to learn a new language.", "Она решила выучить новый язык.", "A2"),
        (deck1, "comfortable", "/ˈkʌmf.tə.bəl/", "adjective", "удобный, комфортный", "These running shoes are very comfortable for long walks.", "Эти кроссовки очень удобные для долгих прогулок.", "Make yourself comfortable on the sofa.", "Устраивайтесь поудобнее на диване.", "A2"),
        (deck1, "borrow", "/ˈbɒr.əʊ/", "verb", "одалживать, брать взаймы", "Can I borrow your pen for a minute?", "Можно одолжить твою ручку на минуту?", "I often borrow interesting books from the local library.", "Я часто беру интересные книги в местной библиотеке.", "A2"),
        (deck1, "explain", "/ɪkˈspleɪn/", "verb", "объяснять", "Could you explain this grammar rule one more time?", "Не могли бы вы объяснить это правило грамматики ещё раз?", "He explained the plan clearly to everyone.", "Он понятно объяснил план всем.", "A2"),
        (deck2, "experience", "/ɪkˈspɪə.ri.əns/", "noun", "опыт, впечатление", "Traveling abroad was an unforgettable experience for me.", "Путешествие за границу стало для меня незабываемым опытом.", "Do you have any experience in customer support?", "У вас есть опыт работы в поддержке клиентов?", "B1"),
        (deck2, "opportunity", "/ˌɒp.əˈtʃuː.nə.ti/", "noun", "возможность, шанс", "This trip is a great opportunity to practice speaking English.", "Эта поездка — отличная возможность попрактиковать разговорный английский.", "Do not miss the opportunity to meet new people.", "Не упустите возможность познакомиться с новыми людьми.", "B1"),
        (deck2, "reliable", "/rɪˈlaɪ.ə.bəl/", "adjective", "надёжный", "He is a very reliable friend who always keeps his promises.", "Он очень надёжный друг, который всегда держит свои обещания.", "We need a reliable internet connection for the call.", "Нам нужно надёжное интернет-соединение для созвона.", "B1"),
        (deck2, "prepare", "/prɪˈpeər/", "verb", "готовиться, подготавливать", "I need to prepare for my English test tomorrow.", "Мне нужно подготовиться к завтрашнему тесту по английскому.", "She helped us prepare dinner for the guests.", "Она помогла нам приготовить ужин для гостей.", "A2"),
        (deck2, "suggest", "/səˈdʒest/", "verb", "предлагать (идею)", "I suggest taking a short break before we continue.", "Я предлагаю сделать небольшой перерыв, прежде чем мы продолжим.", "What restaurant do you suggest for tonight?", "Какой ресторан ты посоветуешь на сегодняшний вечер?", "B1"),
        (deck3, "look forward to", "/lʊk ˈfɔː.wəd tuː/", "phrasal verb", "с нетерпением ждать", "I really look forward to seeing you next weekend.", "Я очень жду встречи с тобой на следующих выходных.", "We are looking forward to our summer holiday.", "Мы с нетерпением ждём нашего летнего отпуска.", "B1"),
    ]

    now = datetime.now(timezone.utc)
    for idx, w in enumerate(starter_words):
        due_iso = (now - timedelta(minutes=len(starter_words) - idx)).isoformat().replace("+00:00", "Z")
        img_url = STARTER_WORD_IMAGES.get(w[1].lower(), "")
        conn.execute(
            """
            INSERT INTO words (
              user_id, deck_id, word, phonetic, part_of_speech, translation,
              example_en, example_ru, secondary_example_en, secondary_example_ru,
              cefr_level, image_url, ease_factor, interval_days, repetitions, status, next_review_at, last_reviewed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2.5, 0, 0, 'new', ?, NULL)
            """,
            (learner_id, w[0], w[1], w[2], w[3], w[4], w[5], w[6], w[7], w[8], w[9], img_url, due_iso),
        )

    for w in starter_words[:8]:
        due_iso = (now - timedelta(minutes=30)).isoformat().replace("+00:00", "Z")
        img_url = STARTER_WORD_IMAGES.get(w[1].lower(), "")
        conn.execute(
            """
            INSERT INTO words (
              user_id, deck_id, word, phonetic, part_of_speech, translation,
              example_en, example_ru, secondary_example_en, secondary_example_ru,
              cefr_level, image_url, ease_factor, interval_days, repetitions, status, next_review_at, last_reviewed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2.5, 0, 0, 'new', ?, NULL)
            """,
            (admin_id, w[0], w[1], w[2], w[3], w[4], w[5], w[6], w[7], w[8], w[9], img_url, due_iso),
        )

    conn.execute(
        """
        INSERT INTO words (
          user_id, deck_id, word, phonetic, part_of_speech, translation,
          example_en, example_ru, secondary_example_en, secondary_example_ru,
          cefr_level, image_url, ease_factor, interval_days, repetitions, status, next_review_at, last_reviewed_at
        ) VALUES (?, ?, 'figure out', '/ˈfɪɡ.ər aʊt/', 'phrasal verb', 'разобраться, понять, найти решение',
          'Let us figure out how to solve this task together.', 'Давай вместе разберёмся, как решить эту задачу.',
          'It took me ten minutes to figure out the new app.', 'Мне понадобилось десять минут, чтобы разобраться в новом приложении.',
          'B1', ?, 2.5, 0, 0, 'new', ?, NULL)
        """,
        (admin_id, deck3, STARTER_WORD_IMAGES.get("figure out", ""), now.isoformat().replace("+00:00", "Z")),
    )

    conn.execute(
        "INSERT INTO notifications (user_id, type, title, message, is_read) VALUES (?, 'reminder', ?, ?, 0)",
        (learner_id, "Добро пожаловать в nekaLexi", "Базовые карточки уровня A2–B1 готовы к первому изучению."),
    )
    conn.commit()
    seed_starter_words_for_level(conn, personal_id, "A2")

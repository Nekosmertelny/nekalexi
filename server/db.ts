import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { getCanonicalEmail } from './auth.ts';
import {
  CURATED_DECKS_CATALOG,
  getCuratedDecksForLevel,
  normalizeCefrLevel,
  STARTER_WORD_IMAGES,
  type CefrLevel,
} from './curatedCatalog.ts';

export function initDatabase(dbPath?: string): Database.Database {
  const resolvedPath =
    dbPath || process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'lexiforge.db');

  if (resolvedPath !== ':memory:') {
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(resolvedPath);

  // High-performance SQLite tuning
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -32000'); // 32MB page cache

  db.exec(`
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

    -- Composite & covering indexes for high-throughput SM-2 and analytics queries
    CREATE INDEX IF NOT EXISTS idx_words_user_due ON words(user_id, next_review_at);
    CREATE INDEX IF NOT EXISTS idx_words_user_status ON words(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_words_deck ON words(deck_id);
    CREATE INDEX IF NOT EXISTS idx_review_logs_user_date ON review_logs(user_id, reviewed_at);
    CREATE INDEX IF NOT EXISTS idx_writing_user_date ON writing_submissions(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, is_read, created_at);
    CREATE INDEX IF NOT EXISTS idx_users_xp ON users(xp DESC);
  `);

  const userColumns = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
  if (!userColumns.some((c) => c.name === 'canonical_email')) {
    db.exec('ALTER TABLE users ADD COLUMN canonical_email TEXT');
  }
  if (!userColumns.some((c) => c.name === 'cefr_level')) {
    db.exec("ALTER TABLE users ADD COLUMN cefr_level TEXT NOT NULL DEFAULT 'A2'");
  }

  const wordColumns = db.prepare('PRAGMA table_info(words)').all() as Array<{ name: string }>;
  if (!wordColumns.some((c) => c.name === 'image_url')) {
    db.exec("ALTER TABLE words ADD COLUMN image_url TEXT NOT NULL DEFAULT ''");
  }
  if (!wordColumns.some((c) => c.name === 'fsrs_stability')) {
    db.exec('ALTER TABLE words ADD COLUMN fsrs_stability REAL NOT NULL DEFAULT 0');
  }
  if (!wordColumns.some((c) => c.name === 'fsrs_difficulty')) {
    db.exec('ALTER TABLE words ADD COLUMN fsrs_difficulty REAL NOT NULL DEFAULT 0');
  }
  if (!wordColumns.some((c) => c.name === 'fsrs_state')) {
    db.exec('ALTER TABLE words ADD COLUMN fsrs_state INTEGER NOT NULL DEFAULT 0');
  }
  if (!wordColumns.some((c) => c.name === 'fsrs_lapses')) {
    db.exec('ALTER TABLE words ADD COLUMN fsrs_lapses INTEGER NOT NULL DEFAULT 0');
  }
  if (!wordColumns.some((c) => c.name === 'fsrs_learning_steps')) {
    db.exec('ALTER TABLE words ADD COLUMN fsrs_learning_steps INTEGER NOT NULL DEFAULT 0');
  }

  // Migrate legacy SM-2 progress to FSRS initial values where needed
  db.exec(`
    UPDATE words
    SET fsrs_stability = CASE WHEN interval_days > 0 THEN interval_days ELSE 1 END,
        fsrs_difficulty = 5.0,
        fsrs_state = CASE WHEN status = 'learning' THEN 1 ELSE 2 END
    WHERE repetitions > 0 AND fsrs_state = 0
  `);

  const usersWithoutCanonical = db
    .prepare("SELECT id, email FROM users WHERE canonical_email IS NULL OR canonical_email = ''")
    .all() as Array<{ id: number; email: string }>;
  if (usersWithoutCanonical.length > 0) {
    const updateCanonical = db.prepare('UPDATE users SET canonical_email = ? WHERE id = ?');
    for (const u of usersWithoutCanonical) {
      updateCanonical.run(getCanonicalEmail(u.email), u.id);
    }
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users(lower(trim(email)));
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_canonical_email ON users(canonical_email) WHERE canonical_email IS NOT NULL;
  `);

  seedInitialData(db);
  ensureCuratedCatalogAndImages(db);
  return db;
}

export function seedStarterWordsForLevel(
  db: Database.Database,
  userId: number,
  rawLevel: string
): { deckId: number; addedCount: number } {
  const level: CefrLevel = normalizeCefrLevel(rawLevel);
  const specs = getCuratedDecksForLevel(level);
  const primarySpec = specs[0];

  const existingCurated = db
    .prepare('SELECT id FROM decks WHERE is_curated = 1 AND lower(title) = lower(?)')
    .get(primarySpec.title) as { id: number } | undefined;

  let targetDeckId: number;
  if (existingCurated) {
    targetDeckId = existingCurated.id;
  } else {
    const deckRes = db
      .prepare('INSERT INTO decks (user_id, title, description, category, cefr_level, is_curated) VALUES (?, ?, ?, ?, ?, 0)')
      .run(userId, primarySpec.title, primarySpec.description, primarySpec.category, primarySpec.cefrLevel);
    targetDeckId = Number(deckRes.lastInsertRowid);
  }

  const insertStarter = db.prepare(`
    INSERT INTO words (
      user_id, deck_id, word, phonetic, part_of_speech, translation,
      example_en, example_ru, secondary_example_en, secondary_example_ru,
      cefr_level, image_url, status
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new'
    WHERE NOT EXISTS (SELECT 1 FROM words WHERE user_id = ? AND lower(word) = lower(?))
  `);

  let addedCount = 0;
  const now = Date.now();
  const tx = db.transaction(() => {
    for (let i = 0; i < primarySpec.words.length; i++) {
      const w = primarySpec.words[i];
      const res = insertStarter.run(
        userId,
        targetDeckId,
        w.word,
        w.phonetic,
        w.partOfSpeech,
        w.translation,
        w.exampleEn,
        w.exampleRu,
        w.secondaryExampleEn,
        w.secondaryExampleRu,
        w.cefrLevel,
        w.imageUrl,
        userId,
        w.word
      );
      if (res.changes > 0) addedCount++;
    }
    // Stagger due timestamps slightly so order matches starter list
    db.prepare('UPDATE words SET next_review_at = ? WHERE user_id = ?').run(
      new Date(now - 60_000).toISOString(),
      userId
    );
  });
  tx();

  return { deckId: targetDeckId, addedCount };
}

function ensureCuratedCatalogAndImages(db: Database.Database): void {
  // Backfill missing images and upgrade legacy off-topic/historical starter URLs
  const missingImgRows = db
    .prepare(
      `SELECT id, word FROM words
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
          OR image_url LIKE '%Quercus_robur%'`
    )
    .all() as Array<{ id: number; word: string }>;

  if (missingImgRows.length > 0) {
    const updateImg = db.prepare('UPDATE words SET image_url = ? WHERE id = ?');
    for (const row of missingImgRows) {
      const match = STARTER_WORD_IMAGES[row.word.trim().toLowerCase()];
      if (match) {
        updateImg.run(match, row.id);
      }
    }
  }

  // Ensure curated decks across all A1-C1 levels exist for browsing/cloning
  const adminRow = db
    .prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1")
    .get() as { id: number } | undefined;
  const ownerId = adminRow?.id ?? null;
  if (!ownerId) return;

  for (const spec of CURATED_DECKS_CATALOG) {
    const existingDeck = db
      .prepare('SELECT id FROM decks WHERE is_curated = 1 AND lower(title) = lower(?)')
      .get(spec.title) as { id: number } | undefined;

    let deckId = existingDeck?.id;
    if (!deckId) {
      const res = db
        .prepare(
          'INSERT INTO decks (user_id, title, description, category, cefr_level, is_curated) VALUES (?, ?, ?, ?, ?, 1)'
        )
        .run(ownerId, spec.title, spec.description, spec.category, spec.cefrLevel);
      deckId = Number(res.lastInsertRowid);
    }

    const existingWordsCount = (
      db.prepare('SELECT COUNT(*) as cnt FROM words WHERE deck_id = ?').get(deckId) as { cnt: number }
    ).cnt;

    if (existingWordsCount === 0) {
      const insertWord = db.prepare(`
        INSERT INTO words (
          user_id, deck_id, word, phonetic, part_of_speech, translation,
          example_en, example_ru, secondary_example_en, secondary_example_ru,
          cefr_level, image_url, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')
      `);
      for (const w of spec.words) {
        // Avoid colliding if owner already owns that word in another deck — store with ownerId; clone queries filter distinct word
        insertWord.run(
          ownerId,
          deckId,
          w.word,
          w.phonetic,
          w.partOfSpeech,
          w.translation,
          w.exampleEn,
          w.exampleRu,
          w.secondaryExampleEn,
          w.secondaryExampleRu,
          w.cefrLevel,
          w.imageUrl
        );
      }
    }
  }
}

function seedInitialData(db: Database.Database): void {
  const existingAchievements = db.prepare('SELECT COUNT(*) as cnt FROM achievements').get() as { cnt: number };
  if (existingAchievements.cnt === 0) {
    const insertAch = db.prepare(`
      INSERT INTO achievements (code, title, description, icon, xp_reward, threshold, category)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const achievements = [
      ['first_word', 'Первый шаг', 'Добавьте свое первое английское слово в словарь', 'BookOpen', 30, 1, 'vocabulary'],
      ['vocab_20', 'Собиратель лексики', 'Соберите 20 слов в личном словаре', 'Layers', 75, 20, 'vocabulary'],
      ['first_review', 'Начало интервалов', 'Завершите первое повторение карточки по FSRS', 'Sparkles', 25, 1, 'study'],
      ['streak_7', 'Неделя дисциплины', 'Поддерживайте серию занятий 7 дней подряд', 'Flame', 150, 7, 'streak'],
      ['master_5', 'Уверенное владение', 'Доведите 5 слов до статуса «Выучено»', 'Award', 120, 5, 'mastery'],
      ['writer_5', 'Мастер контекста', 'Проверьте 5 предложений с новой лексикой у ИИ-наставника', 'PenTool', 100, 5, 'writing'],
      ['grammar_90', 'Безупречная грамматика', 'Получите оценку грамматики 90+ баллов от ИИ', 'CheckCircle2', 80, 90, 'writing'],
    ];
    for (const a of achievements) {
      insertAch.run(...a);
    }
  } else {
    db.prepare(
      "UPDATE achievements SET description = 'Завершите первое повторение карточки по FSRS' WHERE code = 'first_review'"
    ).run();
  }

  const existingUsers = db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number };
  if (existingUsers.cnt > 0) return;

  const learnerHash = bcrypt.hashSync('Nekajon1608', 10);
  const adminHash = bcrypt.hashSync('Nekajon1608', 10);
  const todayStr = new Date().toISOString().slice(0, 10);

  const insertUser = db.prepare(`
    INSERT INTO users (email, canonical_email, name, password_hash, role, xp, level, streak_days, last_study_date, daily_goal, reminder_enabled, reminder_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const learnerRes = insertUser.run(
    'learner@lexiforge.io',
    getCanonicalEmail('learner@lexiforge.io'),
    'neka',
    learnerHash,
    'user',
    0,
    1,
    0,
    null,
    15,
    1,
    '19:00'
  );
  const learnerId = Number(learnerRes.lastInsertRowid);

  const adminRes = insertUser.run(
    'admin@lexiforge.io',
    getCanonicalEmail('admin@lexiforge.io'),
    'nekaadmin',
    adminHash,
    'admin',
    1280,
    13,
    14,
    todayStr,
    20,
    1,
    '20:00'
  );
  const adminId = Number(adminRes.lastInsertRowid);

  const personalRes = insertUser.run(
    'nekajon.nekka@gmail.com',
    getCanonicalEmail('nekajon.nekka@gmail.com'),
    'nekajon',
    learnerHash,
    'user',
    0,
    1,
    0,
    null,
    15,
    1,
    '19:00'
  );
  const personalId = Number(personalRes.lastInsertRowid);

  // Curated & user decks (A2 - B1)
  const insertDeck = db.prepare(`
    INSERT INTO decks (user_id, title, description, category, cefr_level, is_curated)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const deck1 = Number(
    insertDeck.run(
      learnerId,
      'Повседневный английский (A2)',
      'Базовые глаголы и прилагательные для общения каждый день.',
      'Повседневное',
      'A2',
      1
    ).lastInsertRowid
  );
  const deck2 = Number(
    insertDeck.run(
      learnerId,
      'Работа, поездки и планы (B1)',
      'Полезные слова среднего уровня для работы, путешествий и переписки.',
      'Общение',
      'B1',
      1
    ).lastInsertRowid
  );
  const deck3 = Number(
    insertDeck.run(
      adminId,
      'Полезные фразы (A2–B1)',
      'Частые фразовые глаголы, которые легко использовать в речи.',
      'Разговорный',
      'B1',
      1
    ).lastInsertRowid
  );

  const now = Date.now();
  const hourMs = 3600 * 1000;
  const dayMs = 24 * hourMs;

  const insertWord = db.prepare(`
    INSERT INTO words (
      user_id, deck_id, word, phonetic, part_of_speech, translation,
      example_en, example_ru, secondary_example_en, secondary_example_ru,
      cefr_level, image_url, ease_factor, interval_days, repetitions, status, next_review_at, last_reviewed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const starterWords: Array<[number, string, string, string, string, string, string, string, string, string, number, number, number, string, number]> = [
    [
      deck1,
      'improve',
      '/ɪmˈpruːv/',
      'verb',
      'улучшать, совершенствовать',
      'I read English articles every morning to improve my vocabulary.',
      'Я читаю статьи на английском каждое утро, чтобы улучшить свой словарный запас.',
      'The weather started to improve in the afternoon.',
      'Днём погода начала улучшаться.',
      'A2',
      2.5,
      0,
      0,
      'new',
      -2 * hourMs,
    ],
    [
      deck1,
      'schedule',
      '/ˈskedʒ.uːl/',
      'noun',
      'расписание, график',
      'My work schedule is very busy on Mondays.',
      'Мой рабочий график очень плотный по понедельникам.',
      'We are right on schedule for the train.',
      'Мы идём точно по расписанию к поезду.',
      'A2',
      2.6,
      1,
      1,
      'learning',
      -1 * hourMs,
    ],
    [
      deck1,
      'decide',
      '/dɪˈsaɪd/',
      'verb',
      'решать, принимать решение',
      'We need to decide where to go on vacation this summer.',
      'Нам нужно решить, куда поехать в отпуск этим летом.',
      'She decided to learn a new language.',
      'Она решила выучить новый язык.',
      'A2',
      2.5,
      0,
      0,
      'new',
      -30 * 60 * 1000,
    ],
    [
      deck1,
      'comfortable',
      '/ˈkʌmf.tə.bəl/',
      'adjective',
      'удобный, комфортный',
      'These running shoes are very comfortable for long walks.',
      'Эти кроссовки очень удобные для долгих прогулок.',
      'Make yourself comfortable on the sofa.',
      'Устраивайтесь поудобнее на диване.',
      'A2',
      2.7,
      6,
      2,
      'review',
      -3 * hourMs,
    ],
    [
      deck1,
      'borrow',
      '/ˈbɒr.əʊ/',
      'verb',
      'одалживать, брать взаймы',
      'Can I borrow your pen for a minute?',
      'Можно одолжить твою ручку на минуту?',
      'I often borrow interesting books from the local library.',
      'Я часто беру интересные книги в местной библиотеке.',
      'A2',
      2.65,
      24,
      4,
      'mastered',
      10 * dayMs,
    ],
    [
      deck1,
      'explain',
      '/ɪkˈspleɪn/',
      'verb',
      'объяснять',
      'Could you explain this grammar rule one more time?',
      'Не могли бы вы объяснить это правило грамматики ещё раз?',
      'He explained the plan clearly to everyone.',
      'Он понятно объяснил план всем.',
      'A2',
      2.55,
      22,
      4,
      'mastered',
      8 * dayMs,
    ],
    [
      deck2,
      'experience',
      '/ɪkˈspɪə.ri.əns/',
      'noun',
      'опыт, впечатление',
      'Traveling abroad was an unforgettable experience for me.',
      'Путешествие за границу стало для меня незабываемым опытом.',
      'Do you have any experience in customer support?',
      'У вас есть опыт работы в поддержке клиентов?',
      'B1',
      2.3,
      1,
      1,
      'learning',
      -4 * hourMs,
    ],
    [
      deck2,
      'opportunity',
      '/ˌɒp.əˈtʃuː.nə.ti/',
      'noun',
      'возможность, шанс',
      'This trip is a great opportunity to practice speaking English.',
      'Эта поездка — отличная возможность попрактиковать разговорный английский.',
      'Do not miss the opportunity to meet new people.',
      'Не упустите возможность познакомиться с новыми людьми.',
      'B1',
      2.5,
      0,
      0,
      'new',
      -10 * 60 * 1000,
    ],
    [
      deck2,
      'reliable',
      '/rɪˈlaɪ.ə.bəl/',
      'adjective',
      'надёжный',
      'He is a very reliable friend who always keeps his promises.',
      'Он очень надёжный друг, который всегда держит свои обещания.',
      'We need a reliable internet connection for the call.',
      'Нам нужно надёжное интернет-соединение для созвона.',
      'B1',
      2.2,
      2,
      2,
      'review',
      -20 * 60 * 1000,
    ],
    [
      deck2,
      'prepare',
      '/prɪˈpeər/',
      'verb',
      'готовиться, подготавливать',
      'I need to prepare for my English test tomorrow.',
      'Мне нужно подготовиться к завтрашнему тесту по английскому.',
      'She helped us prepare dinner for the guests.',
      'Она помогла нам приготовить ужин для гостей.',
      'A2',
      2.8,
      30,
      5,
      'mastered',
      14 * dayMs,
    ],
    [
      deck2,
      'suggest',
      '/səˈdʒest/',
      'verb',
      'предлагать (идею)',
      'I suggest taking a short break before we continue.',
      'Я предлагаю сделать небольшой перерыв, прежде чем мы продолжим.',
      'What restaurant do you suggest for tonight?',
      'Какой ресторан ты посоветуешь на сегодняшний вечер?',
      'B1',
      2.5,
      7,
      3,
      'review',
      3 * dayMs,
    ],
    [
      deck3,
      'look forward to',
      '/lʊk ˈfɔː.wəd tuː/',
      'phrasal verb',
      'с нетерпением ждать',
      'I really look forward to seeing you next weekend.',
      'Я очень жду встречи с тобой на следующих выходных.',
      'We are looking forward to our summer holiday.',
      'Мы с нетерпением ждём нашего летнего отпуска.',
      'B1',
      2.5,
      0,
      0,
      'new',
      -5 * 60 * 1000,
    ],
  ];

  for (let idx = 0; idx < starterWords.length; idx++) {
    const w = starterWords[idx];
    const dueIso = new Date(now - (starterWords.length - idx) * 60 * 1000).toISOString();
    const imgUrl = STARTER_WORD_IMAGES[w[1].toLowerCase()] || '';
    insertWord.run(
      learnerId,
      w[0],
      w[1],
      w[2],
      w[3],
      w[4],
      w[5],
      w[6],
      w[7],
      w[8],
      w[9],
      imgUrl,
      2.5,
      0,
      0,
      'new',
      dueIso,
      null
    );
  }

  // Also seed A2-B1 starter words for nekaadmin so admin account can study right away too
  for (const w of starterWords.slice(0, 8)) {
    const dueIso = new Date(now - 30 * 60 * 1000).toISOString();
    const imgUrl = STARTER_WORD_IMAGES[w[1].toLowerCase()] || '';
    insertWord.run(
      adminId,
      w[0],
      w[1],
      w[2],
      w[3],
      w[4],
      w[5],
      w[6],
      w[7],
      w[8],
      w[9],
      imgUrl,
      2.5,
      0,
      0,
      'new',
      dueIso,
      null
    );
  }
  insertWord.run(
    adminId,
    deck3,
    'figure out',
    '/ˈfɪɡ.ər aʊt/',
    'phrasal verb',
    'разобраться, понять, найти решение',
    'Let us figure out how to solve this task together.',
    'Давай вместе разберёмся, как решить эту задачу.',
    'It took me ten minutes to figure out the new app.',
    'Мне понадобилось десять минут, чтобы разобраться в новом приложении.',
    'B1',
    STARTER_WORD_IMAGES['figure out'] || '',
    2.5,
    0,
    0,
    'new',
    new Date(now).toISOString(),
    null
  );

  // Seed initial welcome notification only (zero progress for neka)
  db.prepare('INSERT INTO notifications (user_id, type, title, message, is_read) VALUES (?, ?, ?, ?, ?)').run(
    learnerId,
    'reminder',
    'Добро пожаловать в nekaLexi',
    'Базовые карточки уровня A2–B1 готовы к первому изучению.',
    0
  );

  seedStarterWordsForLevel(db, personalId, 'A2');
}

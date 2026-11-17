import express, { type Express } from 'express';
import type Database from 'better-sqlite3';
import {
  type AuthenticatedRequest,
  getCanonicalEmail,
  hashPassword,
  isValidEmail,
  normalizeEmail,
  requireAdmin,
  requireAuth,
  signJwt,
  verifyPassword,
} from './auth.ts';
import {
  calculateFsrs,
  previewAllFsrsIntervals,
  type ReviewQuality,
  type WordStatus,
} from './fsrs.ts';
import { lookupEnglishDictionary, lookupWordImage, parseWordListInput } from './dictionary.ts';
import { normalizeCefrLevel, STARTER_WORD_IMAGES } from './curatedCatalog.ts';
import { seedStarterWordsForLevel } from './db.ts';
import {
  AiServiceError,
  enrichVocabularyWord,
  evaluateContextWriting,
  evaluateLocallyWithoutAi,
  evaluateTranslationAttempt,
  generateLearningReport,
  generateTranslationPrompt,
  toFriendlyAiError,
  type DbWordHint,
  type TranslationDirection,
} from './ai.ts';
import { awardUserXp, evaluateAndUnlockAchievements } from './gamification.ts';
import type { WsNotificationHub } from './ws.ts';

function loadUserWordHints(
  db: Database.Database,
  userId: number,
  targetWords: string[]
): DbWordHint[] {
  if (targetWords.length === 0) return [];
  const placeholders = targetWords.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT word, translation, example_en, example_ru, secondary_example_en, secondary_example_ru, cefr_level
       FROM words
       WHERE user_id = ? AND lower(word) IN (${placeholders})`
    )
    .all(userId, ...targetWords.map((w) => w.toLowerCase())) as Array<{
    word: string;
    translation: string;
    example_en: string;
    example_ru: string;
    secondary_example_en: string;
    secondary_example_ru: string;
    cefr_level: string;
  }>;

  return rows.map((r) => ({
    word: r.word,
    translation: r.translation,
    exampleEn: r.example_en,
    exampleRu: r.example_ru,
    secondaryExampleEn: r.secondary_example_en,
    secondaryExampleRu: r.secondary_example_ru,
    cefrLevel: r.cefr_level,
  }));
}

function sanitizeUser(row: Record<string, unknown>) {
  const { password_hash: _pw, ...safe } = row;
  return safe;
}

function safeJsonArray<T = unknown>(raw: unknown): T[] {
  try {
    const parsed = JSON.parse(String(raw || '[]'));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function setAuthCookie(res: express.Response, token: string) {
  res.cookie('lexiforge_token', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

export function createApp(db: Database.Database, wsHub: WsNotificationHub | null): Express {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // =========================================================================
  // Health
  // =========================================================================
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      onlineWsClients: wsHub?.getOnlineCount() ?? 0,
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api/media/download', async (req, res) => {
    const rawUrl = typeof req.query.url === 'string' ? req.query.url : '';
    const filename = typeof req.query.name === 'string' ? req.query.name.replace(/[^a-zA-Z0-9._-]/g, '_') : 'nekalexi-photo.jpg';
    try {
      const parsed = new URL(rawUrl);
      const allowedHosts = ['upload.wikimedia.org', 'thumb.wikimedia.org', 'api.openverse.org'];
      if (parsed.protocol !== 'https:' || !allowedHosts.includes(parsed.hostname)) {
        res.status(400).json({ error: 'Недопустимый источник изображения' });
        return;
      }
      const upstream = await fetch(parsed.toString(), {
        headers: { 'User-Agent': 'nekaLexi/1.0 (CC0 Media Downloader)' },
      });
      if (!upstream.ok) {
        res.status(502).json({ error: 'Не удалось загрузить файл с Wikimedia Commons' });
        return;
      }
      const contentType = upstream.headers.get('content-type') || 'image/jpeg';
      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(buffer);
    } catch {
      res.status(400).json({ error: 'Некорректная ссылка на изображение' });
    }
  });

  // Same-origin TTS pronunciation proxy with in-memory MP3 cache
  const ttsAudioCache = new Map<string, Buffer>();
  app.get('/api/audio/tts', requireAuth, async (req: AuthenticatedRequest, res) => {
    const rawText = typeof req.query.text === 'string' ? req.query.text.trim() : '';
    const cleanText = rawText.replace(/\s+/g, ' ').slice(0, 220);
    if (!cleanText) {
      res.status(400).json({ error: 'Укажите текст для озвучивания' });
      return;
    }

    const cacheKey = cleanText.toLowerCase();
    const cached = ttsAudioCache.get(cacheKey);
    if (cached) {
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.send(cached);
      return;
    }

    // Optional upstream audio_url from Dictionary API for single words
    const wordRow = !cleanText.includes(' ')
      ? (db
          .prepare('SELECT audio_url FROM words WHERE lower(word) = ? AND audio_url != \'\' LIMIT 1')
          .get(cacheKey) as { audio_url: string } | undefined)
      : undefined;

    const candidates: Array<{ url: string; headers?: Record<string, string> }> = [];
    if (wordRow?.audio_url && wordRow.audio_url.startsWith('https://')) {
      candidates.push({ url: wordRow.audio_url });
    }
    candidates.push({
      url: `https://translate.googleapis.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q=${encodeURIComponent(cleanText)}`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
        Referer: 'https://translate.google.com/',
      },
    });

    for (const candidate of candidates) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const upstream = await fetch(candidate.url, {
          signal: controller.signal,
          headers: candidate.headers,
        });
        clearTimeout(timeout);
        if (!upstream.ok) continue;
        const ct = upstream.headers.get('content-type') || '';
        const buf = Buffer.from(await upstream.arrayBuffer());
        if (buf.length < 256) continue;
        if (ttsAudioCache.size > 200) {
          const oldestKey = ttsAudioCache.keys().next().value;
          if (oldestKey) ttsAudioCache.delete(oldestKey);
        }
        ttsAudioCache.set(cacheKey, buf);
        res.setHeader('Content-Type', ct.includes('audio') ? ct : 'audio/mpeg');
        res.setHeader('Cache-Control', 'private, max-age=86400');
        res.send(buf);
        return;
      } catch {
        // Try next candidate
      }
    }

    res.status(502).json({ error: 'Сервер озвучивания временно недоступен' });
  });

  // =========================================================================
  // Auth (Email & JWT)
  // =========================================================================

  app.post('/api/auth/register', async (req, res) => {
    try {
      const { email, password, name } = req.body || {};
      const cleanName = String(name || '').trim();
      const normalizedEmail = normalizeEmail(String(email || ''));
      const rawPassword = String(password || '');

      if (!normalizedEmail || !rawPassword || !cleanName) {
        res.status(400).json({ error: 'Заполните имя, email и пароль' });
        return;
      }
      if (cleanName.length < 2) {
        res.status(400).json({ error: 'Имя должно содержать минимум 2 символа' });
        return;
      }
      if (!isValidEmail(normalizedEmail)) {
        res.status(400).json({ error: 'Введите корректный адрес электронной почты' });
        return;
      }
      if (rawPassword.length < 6) {
        res.status(400).json({ error: 'Пароль должен содержать минимум 6 символов' });
        return;
      }

      const canonicalEmail = getCanonicalEmail(normalizedEmail);
      const existing = db
        .prepare('SELECT id FROM users WHERE lower(trim(email)) = ? OR canonical_email = ?')
        .get(normalizedEmail, canonicalEmail);
      if (existing) {
        res.status(409).json({
          error: 'Аккаунт с такой электронной почтой уже зарегистрирован. Войдите в существующий профиль.',
        });
        return;
      }

      const cefrLevel = normalizeCefrLevel((req.body || {}).cefrLevel);
      const passwordHash = await hashPassword(rawPassword);
      const result = db
        .prepare(
          'INSERT INTO users (email, canonical_email, name, password_hash, role, cefr_level, xp, level, streak_days) VALUES (?, ?, ?, ?, ?, ?, 0, 1, 0)'
        )
        .run(normalizedEmail, canonicalEmail, cleanName, passwordHash, 'user', cefrLevel);

      const userId = Number(result.lastInsertRowid);

      // Seed level-tailored starter words (A1-C1) with real photographs
      seedStarterWordsForLevel(db, userId, cefrLevel);

      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Record<string, unknown>;
      const token = signJwt({ userId, email: normalizedEmail, role: 'user' });
      setAuthCookie(res, token);
      res.status(201).json({ token, user: sanitizeUser(user) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('UNIQUE constraint failed') || msg.includes('SQLITE_CONSTRAINT_UNIQUE')) {
        res.status(409).json({
          error: 'Аккаунт с такой электронной почтой уже зарегистрирован. Войдите в существующий профиль.',
        });
        return;
      }
      console.error('Register error:', err);
      res.status(500).json({ error: 'Ошибка регистрации пользователя' });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    try {
      const { email, password } = req.body || {};
      if (!email || !password) {
        res.status(400).json({ error: 'Введите логин/email и пароль' });
        return;
      }

      type UserLoginRow = Record<string, unknown> & {
        id: number;
        email: string;
        role: 'user' | 'admin';
        password_hash: string | null;
        is_active: number;
      };

      const normalizedIdentifier = normalizeEmail(String(email));
      const rawPassword = String(password);

      let matchedUser: UserLoginRow | undefined = db
        .prepare('SELECT * FROM users WHERE lower(trim(email)) = ?')
        .get(normalizedIdentifier) as UserLoginRow | undefined;

      if (!matchedUser && isValidEmail(normalizedIdentifier)) {
        const canonical = getCanonicalEmail(normalizedIdentifier);
        matchedUser = db
          .prepare('SELECT * FROM users WHERE canonical_email = ?')
          .get(canonical) as UserLoginRow | undefined;
      }

      if (matchedUser) {
        if (!matchedUser.password_hash) {
          res.status(401).json({ error: 'Неверный логин или пароль' });
          return;
        }
        const valid = await verifyPassword(rawPassword, matchedUser.password_hash);
        if (!valid) {
          res.status(401).json({ error: 'Неверный логин или пароль' });
          return;
        }
      } else {
        const byNameCandidates = db
          .prepare('SELECT * FROM users WHERE lower(trim(name)) = ?')
          .all(normalizedIdentifier) as UserLoginRow[];

        for (const candidate of byNameCandidates) {
          if (!candidate.password_hash) continue;
          if (await verifyPassword(rawPassword, candidate.password_hash)) {
            matchedUser = candidate;
            break;
          }
        }
      }

      if (!matchedUser) {
        res.status(401).json({ error: 'Неверный логин или пароль' });
        return;
      }
      if (!matchedUser.is_active) {
        res.status(403).json({ error: 'Аккаунт деактивирован администратором' });
        return;
      }

      const token = signJwt({ userId: matchedUser.id, email: matchedUser.email, role: matchedUser.role });
      setAuthCookie(res, token);
      res.json({ token, user: sanitizeUser(matchedUser) });
    } catch (err) {
      console.error('Login error:', err);
      res.status(500).json({ error: 'Ошибка входа' });
    }
  });

  app.post('/api/auth/logout', (_req, res) => {
    res.clearCookie('lexiforge_token', { sameSite: 'none', secure: true });
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireAuth, (req: AuthenticatedRequest, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.userId) as
      | Record<string, unknown>
      | undefined;
    if (!user) {
      res.status(404).json({ error: 'Пользователь не найден' });
      return;
    }
    const todayStr = new Date().toISOString().slice(0, 10);
    const todayReviews = (
      db
        .prepare('SELECT COUNT(*) as cnt FROM review_logs WHERE user_id = ? AND date(reviewed_at) = ?')
        .get(req.user!.userId, todayStr) as { cnt: number }
    ).cnt;

    res.json({ user: sanitizeUser(user), todayReviews });
  });

  app.put('/api/auth/level', requireAuth, (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    const cefrLevel = normalizeCefrLevel((req.body || {}).cefrLevel);
    const seedDeck = (req.body || {}).seedDeck !== false;

    db.prepare('UPDATE users SET cefr_level = ? WHERE id = ?').run(cefrLevel, userId);
    let addedCount = 0;
    if (seedDeck) {
      addedCount = seedStarterWordsForLevel(db, userId, cefrLevel).addedCount;
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Record<string, unknown>;
    res.json({ user: sanitizeUser(user), addedCount });
  });

  // =========================================================================
  // Decks & Vocabulary + Dictionary API + Batch Import
  // =========================================================================
  app.get('/api/decks', requireAuth, (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    const decks = db
      .prepare(
        `SELECT d.*,
          (SELECT COUNT(*) FROM words w WHERE w.deck_id = d.id AND w.user_id = ?) as word_count,
          (SELECT COUNT(*) FROM words w WHERE w.deck_id = d.id AND w.user_id = ? AND (w.next_review_at <= datetime('now') OR w.status = 'new')) as due_count,
          (SELECT COUNT(*) FROM words w WHERE w.deck_id = d.id) as total_deck_words
         FROM decks d
         WHERE d.user_id = ? OR d.is_curated = 1
         ORDER BY d.is_curated DESC, d.created_at DESC`
      )
      .all(userId, userId, userId);

    res.json({ decks });
  });

  app.post('/api/decks', requireAuth, (req: AuthenticatedRequest, res) => {
    const { title, description, category, cefrLevel } = req.body || {};
    if (!title || !String(title).trim()) {
      res.status(400).json({ error: 'Название колоды обязательно' });
      return;
    }
    const result = db
      .prepare(
        'INSERT INTO decks (user_id, title, description, category, cefr_level, is_curated) VALUES (?, ?, ?, ?, ?, 0)'
      )
      .run(
        req.user!.userId,
        String(title).trim(),
        String(description || '').trim(),
        String(category || 'Личная подборка').trim(),
        String(cefrLevel || 'B1').trim()
      );

    const deck = db.prepare('SELECT * FROM decks WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ deck });
  });

  app.post('/api/decks/:id/clone', requireAuth, (req: AuthenticatedRequest, res) => {
    const deckId = Number(req.params.id);
    const userId = req.user!.userId;
    const rawWords = db.prepare('SELECT * FROM words WHERE deck_id = ? ORDER BY id ASC').all(deckId) as Array<
      Record<string, unknown>
    >;

    const seen = new Set<string>();
    const sourceWords: Array<Record<string, unknown>> = [];
    for (const w of rawWords) {
      const key = String(w.word || '').trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      sourceWords.push(w);
    }

    const insert = db.prepare(`
      INSERT INTO words (
        user_id, deck_id, word, phonetic, part_of_speech, translation,
        example_en, example_ru, secondary_example_en, secondary_example_ru,
        cefr_level, audio_url, image_url, status
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new'
      WHERE NOT EXISTS (SELECT 1 FROM words WHERE user_id = ? AND lower(word) = lower(?))
    `);

    let added = 0;
    const tx = db.transaction(() => {
      for (const w of sourceWords) {
        const wordStr = String(w.word || '');
        const img = String(w.image_url || '') || STARTER_WORD_IMAGES[wordStr.toLowerCase()] || '';
        const r = insert.run(
          userId,
          deckId,
          wordStr,
          w.phonetic,
          w.part_of_speech,
          w.translation,
          w.example_en,
          w.example_ru,
          w.secondary_example_en || '',
          w.secondary_example_ru || '',
          w.cefr_level || 'B1',
          w.audio_url || '',
          img,
          userId,
          wordStr
        );
        if (r.changes > 0) added++;
      }
    });
    tx();

    res.json({ added });
  });

  app.delete('/api/decks/:id', requireAuth, (req: AuthenticatedRequest, res) => {
    const deckId = Number(req.params.id);
    const deck = db.prepare('SELECT * FROM decks WHERE id = ?').get(deckId) as
      | { id: number; user_id: number; is_curated: number }
      | undefined;

    if (!deck) {
      res.status(404).json({ error: 'Колода не найдена' });
      return;
    }
    if (deck.user_id !== req.user!.userId && req.user!.role !== 'admin') {
      res.status(403).json({ error: 'Нет прав на удаление этой колоды' });
      return;
    }

    db.prepare('DELETE FROM decks WHERE id = ?').run(deckId);
    res.json({ ok: true });
  });

  app.get('/api/decks/:id/export', requireAuth, (req: AuthenticatedRequest, res) => {
    const deckId = Number(req.params.id);
    const words = db
      .prepare('SELECT word, translation, part_of_speech, phonetic, example_en, example_ru FROM words WHERE deck_id = ? AND user_id = ?')
      .all(deckId, req.user!.userId) as Array<Record<string, string>>;

    const escapeCsv = (s: string) => `"${String(s || '').replace(/"/g, '""')}"`;
    const header = 'word,translation,part_of_speech,phonetic,example_en,example_ru';
    const rows = words.map((w) =>
      [w.word, w.translation, w.part_of_speech, w.phonetic, w.example_en, w.example_ru].map(escapeCsv).join(',')
    );

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="nekalexi-deck-${deckId}.csv"`);
    res.send([header, ...rows].join('\n'));
  });

  app.get('/api/words', requireAuth, (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    const deckId = req.query.deckId ? Number(req.query.deckId) : null;
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const search = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';

    const conditions = ['w.user_id = ?'];
    const params: unknown[] = [userId];

    if (deckId) {
      conditions.push('w.deck_id = ?');
      params.push(deckId);
    }
    if (status && ['new', 'learning', 'review', 'mastered'].includes(status)) {
      conditions.push('w.status = ?');
      params.push(status);
    }
    if (search) {
      conditions.push('(lower(w.word) LIKE ? OR lower(w.translation) LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }

    const words = db
      .prepare(
        `SELECT w.*, d.title as deck_title
         FROM words w
         LEFT JOIN decks d ON d.id = w.deck_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY w.created_at DESC, w.id DESC`
      )
      .all(...params);

    res.json({ words });
  });

  app.get('/api/words/lookup', requireAuth, async (req, res) => {
    const rawWord = typeof req.query.word === 'string' ? req.query.word.trim() : '';
    const requestedPos = typeof req.query.pos === 'string' ? req.query.pos.trim() : '';
    if (!rawWord) {
      res.status(400).json({ error: 'Укажите слово для поиска в словаре' });
      return;
    }
    const dict = await lookupEnglishDictionary(rawWord, requestedPos || undefined);
    const effectivePos = requestedPos || dict.partOfSpeech || 'noun';
    const starterImg = STARTER_WORD_IMAGES[rawWord.toLowerCase()];
    const [enriched, photoUrl] = await Promise.all([
      enrichVocabularyWord(rawWord, dict, undefined, effectivePos),
      starterImg
        ? Promise.resolve(starterImg)
        : lookupWordImage(rawWord, {
            partOfSpeech: effectivePos,
            englishDefinition: dict.englishDefinition,
          }),
    ]);
    res.json({ dictionary: dict, enriched, imageUrl: photoUrl });
  });

  app.post('/api/words', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user!.userId;
      const {
        word,
        translation,
        partOfSpeech,
        phonetic,
        exampleEn,
        exampleRu,
        secondaryExampleEn,
        secondaryExampleRu,
        deckId,
        cefrLevel,
        imageUrl,
      } = req.body || {};

      if (!word || !String(word).trim()) {
        res.status(400).json({ error: 'Введите английское слово или выражение' });
        return;
      }

      const cleanWord = String(word).trim();
      const requestedPos = typeof partOfSpeech === 'string' ? partOfSpeech.trim() : '';
      const dict = await lookupEnglishDictionary(cleanWord, requestedPos || undefined);
      const effectivePos = requestedPos || dict.partOfSpeech || 'noun';
      const customImageUrl = typeof imageUrl === 'string' && imageUrl.startsWith('https://') ? imageUrl : '';
      const starterImageUrl = STARTER_WORD_IMAGES[cleanWord.toLowerCase()] || '';

      const needsEnrichment = !translation || !exampleEn || !exampleRu;
      const [enriched, lookedUpImage] = await Promise.all([
        needsEnrichment
          ? enrichVocabularyWord(
              cleanWord,
              dict,
              translation ? String(translation).trim() : undefined,
              effectivePos
            )
          : Promise.resolve(null),
        customImageUrl || starterImageUrl
          ? Promise.resolve(customImageUrl || starterImageUrl)
          : lookupWordImage(cleanWord, {
              partOfSpeech: effectivePos,
              englishDefinition: dict.englishDefinition,
            }),
      ]);

      const resolvedImage = lookedUpImage || '';

      const finalTranslation = String(translation || enriched?.translation || cleanWord).trim();
      const finalPhonetic = String(phonetic || dict.phonetic || enriched?.phonetic || '').trim();
      const finalPos = String(requestedPos || enriched?.partOfSpeech || dict.partOfSpeech || 'noun').trim();
      const finalExampleEn = String(exampleEn || enriched?.exampleEn || '').trim();
      const finalExampleRu = String(exampleRu || enriched?.exampleRu || '').trim();
      const finalSecEn = String(secondaryExampleEn || enriched?.secondaryExampleEn || '').trim();
      const finalSecRu = String(secondaryExampleRu || enriched?.secondaryExampleRu || '').trim();
      const finalCefr = String(cefrLevel || enriched?.cefrLevel || 'B1').trim();

      const result = db
        .prepare(
          `INSERT INTO words (
            user_id, deck_id, word, phonetic, part_of_speech, translation,
            example_en, example_ru, secondary_example_en, secondary_example_ru,
            cefr_level, audio_url, image_url, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`
        )
        .run(
          userId,
          deckId ? Number(deckId) : null,
          cleanWord,
          finalPhonetic,
          finalPos,
          finalTranslation,
          finalExampleEn,
          finalExampleRu,
          finalSecEn,
          finalSecRu,
          finalCefr,
          dict.audioUrl || '',
          resolvedImage
        );

      awardUserXp(db, userId, 10, false);
      const unlocked = evaluateAndUnlockAchievements(db, userId, wsHub);
      const created = db.prepare('SELECT * FROM words WHERE id = ?').get(result.lastInsertRowid);

      res.status(201).json({ word: created, unlockedAchievements: unlocked });
    } catch (err) {
      console.error('Create word error:', err);
      res.status(500).json({ error: 'Не удалось добавить слово' });
    }
  });

  app.post('/api/words/:id/refresh-image', requireAuth, async (req: AuthenticatedRequest, res) => {
    const wordId = Number(req.params.id);
    const row = db
      .prepare('SELECT id, user_id, word, part_of_speech, image_url FROM words WHERE id = ?')
      .get(wordId) as
      | { id: number; user_id: number; word: string; part_of_speech: string; image_url: string }
      | undefined;

    if (!row) {
      res.status(404).json({ error: 'Слово не найдено' });
      return;
    }
    if (row.user_id !== req.user!.userId && req.user!.role !== 'admin') {
      res.status(403).json({ error: 'Нет прав на изменение этого слова' });
      return;
    }

    const customQuery = typeof req.body?.query === 'string' ? req.body.query.trim() : undefined;
    const starterImg = STARTER_WORD_IMAGES[row.word.toLowerCase()];
    const excludeUrls = row.image_url ? [row.image_url] : [];
    const dict = !customQuery ? await lookupEnglishDictionary(row.word) : undefined;
    const imageUrl =
      (!customQuery && starterImg && starterImg !== row.image_url ? starterImg : '') ||
      (await lookupWordImage(row.word, {
        partOfSpeech: row.part_of_speech,
        englishDefinition: dict?.englishDefinition,
        hintQuery: customQuery,
        excludeUrls,
      }));
    if (imageUrl) {
      db.prepare('UPDATE words SET image_url = ? WHERE id = ?').run(imageUrl, wordId);
    }
    res.json({ imageUrl });
  });

  app.post('/api/words/import', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user!.userId;
      const { rawContent, format, deckId, deckTitle } = req.body || {};

      if (!rawContent || !String(rawContent).trim()) {
        res.status(400).json({ error: 'Вставьте список слов или загрузите файл' });
        return;
      }

      const entries = parseWordListInput(String(rawContent), format).slice(0, 30);
      if (entries.length === 0) {
        res.status(400).json({ error: 'Не удалось распознать ни одного слова' });
        return;
      }

      let targetDeckId = deckId ? Number(deckId) : null;
      if (!targetDeckId && deckTitle && String(deckTitle).trim()) {
        const dRes = db
          .prepare('INSERT INTO decks (user_id, title, description, category, cefr_level) VALUES (?, ?, ?, ?, ?)')
          .run(userId, String(deckTitle).trim(), 'Импортированный список слов', 'Импорт', 'B1');
        targetDeckId = Number(dRes.lastInsertRowid);
      }

      // Enrich words concurrently in bounded chunks of 5 with parallel photo + translation lookup
      const enrichedItems: Array<{
        word: string;
        phonetic: string;
        partOfSpeech: string;
        translation: string;
        exampleEn: string;
        exampleRu: string;
        secondaryExampleEn: string;
        secondaryExampleRu: string;
        cefrLevel: string;
        audioUrl: string;
        imageUrl: string;
      }> = [];

      for (let i = 0; i < entries.length; i += 5) {
        const chunk = entries.slice(i, i + 5);
        const resolved = await Promise.all(
          chunk.map(async (entry) => {
            const dict = await lookupEnglishDictionary(entry.word, entry.partOfSpeech);
            const effectivePos = entry.partOfSpeech || dict.partOfSpeech || 'noun';
            const starterImg = STARTER_WORD_IMAGES[entry.word.toLowerCase()];
            const photoPromise = starterImg
              ? Promise.resolve(starterImg)
              : Promise.race([
                  lookupWordImage(entry.word, {
                    partOfSpeech: effectivePos,
                    englishDefinition: dict.englishDefinition,
                  }),
                  new Promise<string>((resolve) => setTimeout(() => resolve(''), 2800)),
                ]);

            if (entry.translation && entry.exampleEn && entry.exampleRu) {
              const photoUrl = await photoPromise;
              return {
                word: entry.word,
                phonetic: dict.phonetic || '',
                partOfSpeech: effectivePos,
                translation: entry.translation,
                exampleEn: entry.exampleEn,
                exampleRu: entry.exampleRu,
                secondaryExampleEn: '',
                secondaryExampleRu: '',
                cefrLevel: 'B1',
                audioUrl: dict.audioUrl || '',
                imageUrl: photoUrl,
              };
            }

            const [enriched, photoUrl] = await Promise.all([
              enrichVocabularyWord(entry.word, dict, entry.translation, effectivePos),
              photoPromise,
            ]);
            return {
              word: entry.word,
              phonetic: dict.phonetic || enriched.phonetic,
              partOfSpeech: entry.partOfSpeech || enriched.partOfSpeech,
              translation: entry.translation || enriched.translation,
              exampleEn: entry.exampleEn || enriched.exampleEn,
              exampleRu: entry.exampleRu || enriched.exampleRu,
              secondaryExampleEn: enriched.secondaryExampleEn,
              secondaryExampleRu: enriched.secondaryExampleRu,
              cefrLevel: enriched.cefrLevel,
              audioUrl: dict.audioUrl || '',
              imageUrl: photoUrl,
            };
          })
        );
        enrichedItems.push(...resolved);
      }

      const insertStmt = db.prepare(`
        INSERT INTO words (
          user_id, deck_id, word, phonetic, part_of_speech, translation,
          example_en, example_ru, secondary_example_en, secondary_example_ru,
          cefr_level, audio_url, image_url, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')
      `);

      const insertedIds: number[] = [];
      const tx = db.transaction(() => {
        for (const item of enrichedItems) {
          const r = insertStmt.run(
            userId,
            targetDeckId,
            item.word,
            item.phonetic,
            item.partOfSpeech,
            item.translation,
            item.exampleEn,
            item.exampleRu,
            item.secondaryExampleEn,
            item.secondaryExampleRu,
            item.cefrLevel,
            item.audioUrl,
            item.imageUrl
          );
          insertedIds.push(Number(r.lastInsertRowid));
        }
      });
      tx();

      awardUserXp(db, userId, insertedIds.length * 8, false);
      const unlocked = evaluateAndUnlockAchievements(db, userId, wsHub);

      res.status(201).json({
        importedCount: insertedIds.length,
        deckId: targetDeckId,
        unlockedAchievements: unlocked,
      });
    } catch (err) {
      console.error('Import error:', err);
      res.status(500).json({ error: 'Ошибка импорта списка слов' });
    }
  });

  app.delete('/api/words/:id', requireAuth, (req: AuthenticatedRequest, res) => {
    const wordId = Number(req.params.id);
    const word = db.prepare('SELECT id, user_id FROM words WHERE id = ?').get(wordId) as
      | { id: number; user_id: number }
      | undefined;

    if (!word) {
      res.status(404).json({ error: 'Слово не найдено' });
      return;
    }
    if (word.user_id !== req.user!.userId && req.user!.role !== 'admin') {
      res.status(403).json({ error: 'Нет прав на удаление этого слова' });
      return;
    }

    db.prepare('DELETE FROM words WHERE id = ?').run(wordId);
    res.json({ ok: true });
  });

  // =========================================================================
  // Spaced Repetition (FSRS) Study Queue & Review
  // =========================================================================
  app.get('/api/study/queue', requireAuth, (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    const deckId = req.query.deckId ? Number(req.query.deckId) : null;
    const includeAll = req.query.mode === 'all';

    const params: unknown[] = [userId];
    let deckSql = '';
    if (deckId) {
      deckSql = ' AND w.deck_id = ?';
      params.push(deckId);
    }

    const dueSql = includeAll
      ? ''
      : " AND (w.next_review_at <= datetime('now') OR w.status = 'new')";

    const rows = db
      .prepare(
        `SELECT w.*, d.title as deck_title
         FROM words w
         LEFT JOIN decks d ON d.id = w.deck_id
         WHERE w.user_id = ? ${deckSql} ${dueSql}
         ORDER BY
           CASE w.status WHEN 'learning' THEN 0 WHEN 'new' THEN 1 WHEN 'review' THEN 2 ELSE 3 END,
           w.next_review_at ASC
         LIMIT 30`
      )
      .all(...params) as Array<{
      id: number;
      ease_factor: number;
      interval_days: number;
      repetitions: number;
      fsrs_stability: number;
      fsrs_difficulty: number;
      fsrs_state: number;
      fsrs_lapses: number;
      fsrs_learning_steps: number;
      next_review_at: string;
      last_reviewed_at: string | null;
      status: WordStatus;
      [key: string]: unknown;
    }>;

    const now = new Date();
    const queue = rows.map((row) => ({
      ...row,
      intervalPreviews: previewAllFsrsIntervals(
        {
          dueAt: row.next_review_at,
          stability: row.fsrs_stability,
          difficulty: row.fsrs_difficulty,
          state: row.fsrs_state,
          reps: row.repetitions,
          lapses: row.fsrs_lapses,
          learningSteps: row.fsrs_learning_steps,
          lastReviewedAt: row.last_reviewed_at,
          status: row.status,
          intervalDays: row.interval_days,
        },
        now
      ),
    }));

    res.json({ queue, totalDue: queue.length });
  });

  app.post('/api/study/review', requireAuth, (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    const { wordId, quality } = req.body || {};
    const q = Number(quality) as ReviewQuality;

    if (!wordId || ![1, 2, 3, 4].includes(q)) {
      res.status(400).json({ error: 'Некорректные параметры оценки карточки' });
      return;
    }

    const word = db
      .prepare('SELECT * FROM words WHERE id = ? AND user_id = ?')
      .get(Number(wordId), userId) as
      | {
          id: number;
          ease_factor: number;
          interval_days: number;
          repetitions: number;
          fsrs_stability: number;
          fsrs_difficulty: number;
          fsrs_state: number;
          fsrs_lapses: number;
          fsrs_learning_steps: number;
          next_review_at: string;
          last_reviewed_at: string | null;
          status: WordStatus;
        }
      | undefined;

    if (!word) {
      res.status(404).json({ error: 'Карточка не найдена' });
      return;
    }

    const next = calculateFsrs(
      {
        dueAt: word.next_review_at,
        stability: word.fsrs_stability,
        difficulty: word.fsrs_difficulty,
        state: word.fsrs_state,
        reps: word.repetitions,
        lapses: word.fsrs_lapses,
        learningSteps: word.fsrs_learning_steps,
        lastReviewedAt: word.last_reviewed_at,
        status: word.status,
        intervalDays: word.interval_days,
      },
      q
    );

    const xpEarned = q === 1 ? 5 : q === 2 ? 10 : q === 3 ? 15 : 20;

    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE words
         SET ease_factor = ?, interval_days = ?, repetitions = ?, status = ?,
             fsrs_stability = ?, fsrs_difficulty = ?, fsrs_state = ?, fsrs_lapses = ?, fsrs_learning_steps = ?,
             next_review_at = ?, last_reviewed_at = datetime('now')
         WHERE id = ?`
      ).run(
        next.easeFactor,
        next.intervalDays,
        next.repetitions,
        next.status,
        next.stability,
        next.difficulty,
        next.state,
        next.lapses,
        next.learningSteps,
        next.nextReviewAt,
        word.id
      );

      db.prepare(
        `INSERT INTO review_logs (user_id, word_id, quality, ease_factor_after, interval_after, xp_earned)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(userId, word.id, q, next.easeFactor, next.intervalDays, xpEarned);
    });
    tx();

    const stats = awardUserXp(db, userId, xpEarned, true);
    const unlocked = evaluateAndUnlockAchievements(db, userId, wsHub);

    if (wsHub) {
      wsHub.broadcastAll({
        type: 'leaderboard:updated',
        payload: { userId, xp: stats.xp, level: stats.level },
      });
    }

    res.json({
      fsrs: next,
      sm2: next,
      xpEarned,
      userStats: stats,
      unlockedAchievements: unlocked,
    });
  });

  // =========================================================================
  // AI Context Writing & Grammar Practice
  // =========================================================================
  app.post('/api/practice/check', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user!.userId;
      const { targetWords, sentence, localFallback } = req.body || {};

      const cleanSentence = String(sentence || '').trim();
      const wordsArr = Array.isArray(targetWords)
        ? targetWords.map((w) => String(w).trim()).filter(Boolean)
        : [];

      if (!cleanSentence || cleanSentence.length < 4) {
        res.status(400).json({ error: 'Напишите предложение на английском языке' });
        return;
      }
      if (wordsArr.length === 0) {
        res.status(400).json({ error: 'Выберите хотя бы одно целевое слово' });
        return;
      }

      const feedback = localFallback
        ? evaluateLocallyWithoutAi({
            mode: 'free',
            userText: cleanSentence,
            targetWords: wordsArr,
            dbHints: loadUserWordHints(db, userId, wordsArr),
          })
        : await evaluateContextWriting(wordsArr, cleanSentence);
      const xpEarned = !feedback.aiGenerated ? 8 : feedback.grammarScore >= 85 ? 30 : 15;

      const insertRes = db
        .prepare(
          `INSERT INTO writing_submissions (
            user_id, target_words, user_sentence, corrected_sentence,
            grammar_score, naturalness_score, is_correct, feedback_ru,
            grammar_notes_json, improved_variants_json, xp_earned
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          userId,
          wordsArr.join(', '),
          cleanSentence,
          feedback.correctedSentence,
          feedback.grammarScore,
          feedback.naturalnessScore,
          feedback.isCorrect ? 1 : 0,
          feedback.feedbackRu,
          JSON.stringify(feedback.grammarNotes),
          JSON.stringify(feedback.improvedVariants),
          xpEarned
        );

      const userStats = awardUserXp(db, userId, xpEarned, true);
      const unlocked = evaluateAndUnlockAchievements(db, userId, wsHub);

      res.status(201).json({
        id: Number(insertRes.lastInsertRowid),
        feedback,
        xpEarned,
        userStats,
        unlockedAchievements: unlocked,
      });
    } catch (err) {
      const aiErr = err instanceof AiServiceError ? err : toFriendlyAiError(err);
      console.error('Writing check error:', err instanceof Error ? err.message : err);
      res.status(aiErr.statusCode).json({ error: aiErr.message, code: aiErr.code });
    }
  });

  app.post('/api/practice/translation-prompt', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user!.userId;
      const { targetWords, direction } = req.body || {};
      const dir: TranslationDirection = direction === 'en_to_ru' ? 'en_to_ru' : 'ru_to_en';
      const wordsArr = Array.isArray(targetWords)
        ? targetWords.map((w) => String(w).trim()).filter(Boolean)
        : [];

      if (wordsArr.length === 0) {
        res.status(400).json({ error: 'Выберите хотя бы одно целевое слово из словаря' });
        return;
      }

      const dbHints = loadUserWordHints(db, userId, wordsArr);
      const prompt = await generateTranslationPrompt(wordsArr, dir, dbHints);
      res.json({ prompt });
    } catch (err) {
      const aiErr = err instanceof AiServiceError ? err : toFriendlyAiError(err);
      console.error('Translation prompt error:', err instanceof Error ? err.message : err);
      res.status(aiErr.statusCode).json({ error: aiErr.message, code: aiErr.code });
    }
  });

  app.post('/api/practice/translation-check', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user!.userId;
      const { direction, sourceSentence, userTranslation, targetWords, localFallback } = req.body || {};
      const dir: TranslationDirection = direction === 'en_to_ru' ? 'en_to_ru' : 'ru_to_en';
      const cleanSource = String(sourceSentence || '').trim();
      const cleanUser = String(userTranslation || '').trim();
      const wordsArr = Array.isArray(targetWords)
        ? targetWords.map((w) => String(w).trim()).filter(Boolean)
        : [];

      if (!cleanSource || !cleanUser) {
        res.status(400).json({ error: 'Укажите исходное предложение и ваш перевод' });
        return;
      }

      const feedback = localFallback
        ? evaluateLocallyWithoutAi({
            mode: dir,
            userText: cleanUser,
            targetWords: wordsArr,
            dbHints: loadUserWordHints(db, userId, wordsArr),
            sourceSentence: cleanSource,
          })
        : await evaluateTranslationAttempt(dir, cleanSource, cleanUser, wordsArr);
      const xpEarned = !feedback.aiGenerated ? 8 : feedback.grammarScore >= 85 ? 30 : 18;
      const labelPrefix = dir === 'ru_to_en' ? 'RU → EN' : 'EN → RU';
      const targetLabel = `[${labelPrefix}] ${wordsArr.join(', ') || 'перевод'}`;

      const insertRes = db
        .prepare(
          `INSERT INTO writing_submissions (
            user_id, target_words, user_sentence, corrected_sentence,
            grammar_score, naturalness_score, is_correct, feedback_ru,
            grammar_notes_json, improved_variants_json, xp_earned
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          userId,
          targetLabel,
          `${cleanSource} → ${cleanUser}`,
          feedback.correctedSentence,
          feedback.grammarScore,
          feedback.naturalnessScore,
          feedback.isCorrect ? 1 : 0,
          feedback.feedbackRu,
          JSON.stringify(feedback.grammarNotes),
          JSON.stringify(feedback.improvedVariants),
          xpEarned
        );

      const userStats = awardUserXp(db, userId, xpEarned, true);
      const unlocked = evaluateAndUnlockAchievements(db, userId, wsHub);

      res.status(201).json({
        id: Number(insertRes.lastInsertRowid),
        feedback,
        xpEarned,
        userStats,
        unlockedAchievements: unlocked,
      });
    } catch (err) {
      const aiErr = err instanceof AiServiceError ? err : toFriendlyAiError(err);
      console.error('Translation check error:', err instanceof Error ? err.message : err);
      res.status(aiErr.statusCode).json({ error: aiErr.message, code: aiErr.code });
    }
  });

  app.get('/api/practice/history', requireAuth, (req: AuthenticatedRequest, res) => {
    const rows = db
      .prepare('SELECT * FROM writing_submissions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20')
      .all(req.user!.userId) as Array<Record<string, unknown>>;

    const history = rows.map((r) => ({
      ...r,
      grammarNotes: safeJsonArray(r.grammar_notes_json),
      improvedVariants: safeJsonArray(r.improved_variants_json),
    }));

    res.json({ history });
  });

  // =========================================================================
  // Analytics Dashboard & AI Reports
  // =========================================================================
  app.get('/api/analytics/overview', requireAuth, (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    const todayStr = new Date().toISOString().slice(0, 10);

    const statusCounts = db
      .prepare('SELECT status, COUNT(*) as cnt FROM words WHERE user_id = ? GROUP BY status')
      .all(userId) as Array<{ status: string; cnt: number }>;

    const countsMap: Record<string, number> = { new: 0, learning: 0, review: 0, mastered: 0 };
    for (const row of statusCounts) {
      countsMap[row.status] = row.cnt;
    }
    const totalWords = Object.values(countsMap).reduce((a, b) => a + b, 0);

    const dueWords = (
      db
        .prepare(
          "SELECT COUNT(*) as cnt FROM words WHERE user_id = ? AND (next_review_at <= datetime('now') OR status = 'new')"
        )
        .get(userId) as { cnt: number }
    ).cnt;

    const todayReviews = (
      db
        .prepare('SELECT COUNT(*) as cnt FROM review_logs WHERE user_id = ? AND date(reviewed_at) = ?')
        .get(userId, todayStr) as { cnt: number }
    ).cnt;

    const accuracyRow = db
      .prepare(
        `SELECT
          COUNT(*) as total,
          SUM(CASE WHEN quality >= 3 THEN 1 ELSE 0 END) as passed
         FROM review_logs WHERE user_id = ?`
      )
      .get(userId) as { total: number; passed: number | null };

    const accuracyPercent =
      accuracyRow.total > 0 ? Math.round(((accuracyRow.passed || 0) / accuracyRow.total) * 100) : 100;

    const avgGrammarRow = db
      .prepare('SELECT COALESCE(ROUND(AVG(grammar_score)), 0) as avg_score, COUNT(*) as cnt FROM writing_submissions WHERE user_id = ?')
      .get(userId) as { avg_score: number; cnt: number };

    // Daily reviews for last 14 days
    const dailyRows = db
      .prepare(
        `SELECT date(reviewed_at) as day,
                COUNT(*) as reviews,
                SUM(CASE WHEN quality >= 3 THEN 1 ELSE 0 END) as correct,
                SUM(xp_earned) as xp
         FROM review_logs
         WHERE user_id = ? AND reviewed_at >= datetime('now', '-13 days')
         GROUP BY date(reviewed_at)
         ORDER BY day ASC`
      )
      .all(userId) as Array<{ day: string; reviews: number; correct: number; xp: number }>;

    const dailyMap = new Map(dailyRows.map((r) => [r.day, r]));
    const velocity14d = [];
    for (let d = 13; d >= 0; d--) {
      const dateStr = new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
      const found = dailyMap.get(dateStr);
      velocity14d.push({
        day: dateStr,
        label: dateStr.slice(5).replace('-', '.'),
        reviews: found?.reviews || 0,
        correct: found?.correct || 0,
        xp: found?.xp || 0,
      });
    }

    // 84-day (12 weeks) heatmap
    const heatmapRows = db
      .prepare(
        `SELECT date(reviewed_at) as day, COUNT(*) as cnt
         FROM review_logs
         WHERE user_id = ? AND reviewed_at >= datetime('now', '-83 days')
         GROUP BY date(reviewed_at)`
      )
      .all(userId) as Array<{ day: string; cnt: number }>;
    const heatMap = new Map(heatmapRows.map((r) => [r.day, r.cnt]));
    const heatmap84d = [];
    for (let d = 83; d >= 0; d--) {
      const dateStr = new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
      heatmap84d.push({ day: dateStr, count: heatMap.get(dateStr) || 0 });
    }

    const hardestWords = db
      .prepare(
        `SELECT id, word, translation, ease_factor, fsrs_difficulty, fsrs_stability, fsrs_lapses, repetitions, status
         FROM words
         WHERE user_id = ?
         ORDER BY
           CASE WHEN fsrs_difficulty > 0 THEN fsrs_difficulty ELSE 5.0 END DESC,
           fsrs_lapses DESC,
           ease_factor ASC
         LIMIT 5`
      )
      .all(userId);

    const userRow = db.prepare('SELECT daily_goal, streak_days, xp, level FROM users WHERE id = ?').get(userId) as {
      daily_goal: number;
      streak_days: number;
      xp: number;
      level: number;
    };

    res.json({
      summary: {
        totalWords,
        newWords: countsMap.new,
        learningWords: countsMap.learning,
        reviewWords: countsMap.review,
        masteredWords: countsMap.mastered,
        dueWords,
        todayReviews,
        dailyGoal: userRow?.daily_goal || 15,
        streakDays: userRow?.streak_days || 0,
        xp: userRow?.xp || 0,
        level: userRow?.level || 1,
        accuracyPercent,
        totalReviews: accuracyRow.total,
        avgGrammarScore: avgGrammarRow.avg_score,
        writingCount: avgGrammarRow.cnt,
      },
      velocity14d,
      heatmap84d,
      hardestWords,
    });
  });

  app.get('/api/analytics/reports', requireAuth, (req: AuthenticatedRequest, res) => {
    const rows = db
      .prepare('SELECT * FROM ai_reports WHERE user_id = ? ORDER BY created_at DESC LIMIT 10')
      .all(req.user!.userId) as Array<Record<string, unknown>>;

    const reports = rows.map((r) => ({
      id: r.id,
      title: r.title,
      summaryRu: r.summary_ru,
      strengths: safeJsonArray<string>(r.strengths_json),
      focusAreas: safeJsonArray<string>(r.focus_areas_json),
      actionPlan: safeJsonArray<string>(r.action_plan_json),
      predictedMilestone: r.predicted_milestone,
      createdAt: r.created_at,
    }));

    res.json({ reports });
  });

  app.post('/api/analytics/reports', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user!.userId;
      const user = db.prepare('SELECT name, level, xp, streak_days FROM users WHERE id = ?').get(userId) as {
        name: string;
        level: number;
        xp: number;
        streak_days: number;
      };
      const totalWords = (db.prepare('SELECT COUNT(*) as cnt FROM words WHERE user_id = ?').get(userId) as { cnt: number }).cnt;
      const masteredWords = (
        db.prepare("SELECT COUNT(*) as cnt FROM words WHERE user_id = ? AND status = 'mastered'").get(userId) as { cnt: number }
      ).cnt;
      const learningWords = (
        db.prepare("SELECT COUNT(*) as cnt FROM words WHERE user_id = ? AND status IN ('learning', 'review')").get(userId) as {
          cnt: number;
        }
      ).cnt;
      const dueWords = (
        db
          .prepare("SELECT COUNT(*) as cnt FROM words WHERE user_id = ? AND (next_review_at <= datetime('now') OR status = 'new')")
          .get(userId) as { cnt: number }
      ).cnt;
      const revStats = db
        .prepare(
          `SELECT COUNT(*) as cnt, SUM(CASE WHEN quality >= 3 THEN 1 ELSE 0 END) as passed
           FROM review_logs WHERE user_id = ? AND reviewed_at >= datetime('now', '-14 days')`
        )
        .get(userId) as { cnt: number; passed: number | null };
      const avgGrammar = (
        db.prepare('SELECT COALESCE(ROUND(AVG(grammar_score)), 0) as s FROM writing_submissions WHERE user_id = ?').get(userId) as {
          s: number;
        }
      ).s;
      const hardestWords = db
        .prepare('SELECT word, translation, ease_factor as easeFactor FROM words WHERE user_id = ? ORDER BY ease_factor ASC LIMIT 5')
        .all(userId) as Array<{ word: string; translation: string; easeFactor: number }>;
      const deckTopics = db
        .prepare('SELECT DISTINCT category FROM decks WHERE user_id = ? OR is_curated = 1 LIMIT 5')
        .all(userId) as Array<{ category: string }>;

      const report = await generateLearningReport({
        userName: user.name,
        level: user.level,
        xp: user.xp,
        streakDays: user.streak_days,
        totalWords,
        masteredWords,
        learningWords,
        dueWords,
        reviewsLast14Days: revStats.cnt,
        accuracyPercent: revStats.cnt > 0 ? Math.round(((revStats.passed || 0) / revStats.cnt) * 100) : 100,
        avgGrammarScore: avgGrammar,
        hardestWords,
        recentTopics: deckTopics.map((d) => d.category),
      });

      const insertRes = db
        .prepare(
          `INSERT INTO ai_reports (user_id, title, summary_ru, strengths_json, focus_areas_json, action_plan_json, predicted_milestone)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          userId,
          report.title,
          report.summaryRu,
          JSON.stringify(report.strengths),
          JSON.stringify(report.focusAreas),
          JSON.stringify(report.actionPlan),
          report.predictedMilestone
        );

      res.status(201).json({
        report: {
          id: Number(insertRes.lastInsertRowid),
          ...report,
          createdAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      const aiErr = err instanceof AiServiceError ? err : toFriendlyAiError(err);
      console.error('Report generation error:', err instanceof Error ? err.message : err);
      res.status(aiErr.statusCode).json({ error: aiErr.message, code: aiErr.code });
    }
  });

  // =========================================================================
  // Gamification (Leaderboard & Achievements)
  // =========================================================================
  app.get('/api/gamification/leaderboard', requireAuth, (req: AuthenticatedRequest, res) => {
    const rows = db
      .prepare(
        `SELECT u.id, u.name, u.xp, u.level, u.streak_days, u.avatar_url,
          (SELECT COUNT(*) FROM words w WHERE w.user_id = u.id AND w.status = 'mastered') as mastered_count,
          (SELECT COUNT(*) FROM user_achievements ua WHERE ua.user_id = u.id) as achievements_count
         FROM users u
         WHERE u.is_active = 1
         ORDER BY u.xp DESC, u.streak_days DESC
         LIMIT 25`
      )
      .all();

    res.json({ leaderboard: rows, currentUserId: req.user!.userId });
  });

  app.get('/api/gamification/achievements', requireAuth, (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    const rows = db
      .prepare(
        `SELECT a.*, ua.unlocked_at
         FROM achievements a
         LEFT JOIN user_achievements ua ON ua.achievement_id = a.id AND ua.user_id = ?
         ORDER BY CASE WHEN ua.unlocked_at IS NOT NULL THEN 0 ELSE 1 END, a.id ASC`
      )
      .all(userId);

    res.json({ achievements: rows });
  });

  // =========================================================================
  // Notifications & Daily Reminders
  // =========================================================================
  app.get('/api/notifications', requireAuth, (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    const notifications = db
      .prepare(
        `SELECT * FROM notifications
         WHERE user_id = ? OR user_id IS NULL
         ORDER BY created_at DESC, id DESC
         LIMIT 30`
      )
      .all(userId);

    res.json({ notifications });
  });

  app.post('/api/notifications/:id/read', requireAuth, (req: AuthenticatedRequest, res) => {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND (user_id = ? OR user_id IS NULL)').run(
      Number(req.params.id),
      req.user!.userId
    );
    res.json({ ok: true });
  });

  app.post('/api/notifications/read-all', requireAuth, (req: AuthenticatedRequest, res) => {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user!.userId);
    res.json({ ok: true });
  });

  app.put('/api/notifications/settings', requireAuth, (req: AuthenticatedRequest, res) => {
    const { dailyGoal, reminderEnabled, reminderTime } = req.body || {};
    const parsedGoal = Number(dailyGoal);
    const goal = Number.isFinite(parsedGoal) ? Math.max(5, Math.min(200, Math.round(parsedGoal))) : 15;
    const enabled = reminderEnabled ? 1 : 0;
    const time = /^\d{2}:\d{2}$/.test(String(reminderTime || '')) ? String(reminderTime) : '19:00';

    db.prepare('UPDATE users SET daily_goal = ?, reminder_enabled = ?, reminder_time = ? WHERE id = ?').run(
      goal,
      enabled,
      time,
      req.user!.userId
    );

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.userId) as Record<string, unknown>;
    res.json({ user: sanitizeUser(user) });
  });

  app.post('/api/notifications/test-reminder', requireAuth, (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    const dueCount = (
      db
        .prepare("SELECT COUNT(*) as cnt FROM words WHERE user_id = ? AND (next_review_at <= datetime('now') OR status = 'new')")
        .get(userId) as { cnt: number }
    ).cnt;

    const title = 'Напоминание о практике';
    const message =
      dueCount > 0
        ? `Сейчас к интервальному повторению готово карточек: ${dueCount}. Посвятите 5 минут повторению!`
        : 'Дневная норма выполнена! Закрепите слова через ИИ-практику предложений.';

    const insertRes = db
      .prepare('INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)')
      .run(userId, 'reminder', title, message);

    const notif = {
      id: Number(insertRes.lastInsertRowid),
      user_id: userId,
      type: 'reminder',
      title,
      message,
      is_read: 0,
      created_at: new Date().toISOString(),
    };

    if (wsHub) {
      wsHub.sendToUser(userId, { type: 'reminder:due', payload: notif });
    }

    res.json({ notification: notif });
  });

  // =========================================================================
  // Admin Panel (RBAC: admin only)
  // =========================================================================
  app.get('/api/admin/overview', requireAuth, requireAdmin, (_req, res) => {
    const t0 = performance.now();
    const totalUsers = (db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number }).cnt;
    const activeUsers = (db.prepare('SELECT COUNT(*) as cnt FROM users WHERE is_active = 1').get() as { cnt: number }).cnt;
    const totalWords = (db.prepare('SELECT COUNT(*) as cnt FROM words').get() as { cnt: number }).cnt;
    const totalReviews = (db.prepare('SELECT COUNT(*) as cnt FROM review_logs').get() as { cnt: number }).cnt;
    const totalWritings = (db.prepare('SELECT COUNT(*) as cnt FROM writing_submissions').get() as { cnt: number }).cnt;
    const totalDecks = (db.prepare('SELECT COUNT(*) as cnt FROM decks').get() as { cnt: number }).cnt;
    const queryLatencyMs = Number((performance.now() - t0).toFixed(2));

    res.json({
      stats: {
        totalUsers,
        activeUsers,
        totalWords,
        totalReviews,
        totalWritings,
        totalDecks,
        queryLatencyMs,
        onlineWsClients: wsHub?.getOnlineCount() ?? 0,
      },
    });
  });

  app.get('/api/admin/users', requireAuth, requireAdmin, (_req, res) => {
    const users = db
      .prepare(
        `SELECT u.id, u.email, u.name, u.role, u.oauth_provider, u.xp, u.level, u.streak_days, u.is_active, u.created_at,
          (SELECT COUNT(*) FROM words w WHERE w.user_id = u.id) as words_count,
          (SELECT COUNT(*) FROM review_logs r WHERE r.user_id = u.id) as reviews_count
         FROM users u
         ORDER BY u.created_at DESC`
      )
      .all();

    res.json({ users });
  });

  app.patch('/api/admin/users/:id', requireAuth, requireAdmin, (req: AuthenticatedRequest, res) => {
    const targetId = Number(req.params.id);
    const { role, isActive } = req.body || {};

    if (targetId === req.user!.userId && isActive === false) {
      res.status(400).json({ error: 'Нельзя деактивировать собственный аккаунт администратора' });
      return;
    }

    const existing = db.prepare('SELECT id, role, is_active FROM users WHERE id = ?').get(targetId) as
      | { id: number; role: string; is_active: number }
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Пользователь не найден' });
      return;
    }

    const nextRole = role === 'admin' || role === 'user' ? role : existing.role;
    const nextActive = typeof isActive === 'boolean' ? (isActive ? 1 : 0) : existing.is_active;

    db.prepare('UPDATE users SET role = ?, is_active = ? WHERE id = ?').run(nextRole, nextActive, targetId);
    const updated = db
      .prepare('SELECT id, email, name, role, xp, level, streak_days, is_active, created_at FROM users WHERE id = ?')
      .get(targetId);

    res.json({ user: updated });
  });

  app.get('/api/admin/content', requireAuth, requireAdmin, (_req, res) => {
    const curatedDecks = db.prepare('SELECT * FROM decks WHERE is_curated = 1 ORDER BY id DESC').all();
    const recentWords = db
      .prepare(
        `SELECT w.id, w.word, w.translation, w.cefr_level, w.status, u.name as owner_name, d.title as deck_title
         FROM words w
         LEFT JOIN users u ON u.id = w.user_id
         LEFT JOIN decks d ON d.id = w.deck_id
         ORDER BY w.id DESC
         LIMIT 50`
      )
      .all();
    res.json({ curatedDecks, recentWords });
  });

  app.post('/api/admin/curated-deck', requireAuth, requireAdmin, (req: AuthenticatedRequest, res) => {
    const { title, description, category, cefrLevel } = req.body || {};
    if (!title || !String(title).trim()) {
      res.status(400).json({ error: 'Введите название системной колоды' });
      return;
    }
    const result = db
      .prepare('INSERT INTO decks (user_id, title, description, category, cefr_level, is_curated) VALUES (?, ?, ?, ?, ?, 1)')
      .run(
        req.user!.userId,
        String(title).trim(),
        String(description || '').trim(),
        String(category || 'Подборка редакции').trim(),
        String(cefrLevel || 'B1').trim()
      );

    const deck = db.prepare('SELECT * FROM decks WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ deck });
  });

  app.post('/api/admin/broadcast', requireAuth, requireAdmin, (req, res) => {
    const { title, message } = req.body || {};
    if (!title || !message) {
      res.status(400).json({ error: 'Заголовок и текст уведомления обязательны' });
      return;
    }

    const insertRes = db
      .prepare('INSERT INTO notifications (user_id, type, title, message) VALUES (NULL, ?, ?, ?)')
      .run('system', String(title).trim(), String(message).trim());

    const payload = {
      id: Number(insertRes.lastInsertRowid),
      user_id: null,
      type: 'system',
      title: String(title).trim(),
      message: String(message).trim(),
      is_read: 0,
      created_at: new Date().toISOString(),
    };

    if (wsHub) {
      wsHub.broadcastAll({ type: 'admin:broadcast', payload });
    }

    res.status(201).json({ notification: payload, deliveredOnline: wsHub?.getOnlineCount() ?? 0 });
  });

  return app;
}

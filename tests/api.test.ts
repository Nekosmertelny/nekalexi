import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import type Database from 'better-sqlite3';
import { initDatabase } from '../server/db.ts';
import { createApp } from '../server/app.ts';

describe('LexiForge REST API & RBAC', () => {
  let db: Database.Database;
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    db = initDatabase(':memory:');
    const app = createApp(db, null);
    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });

  it('rejects unauthenticated access to protected endpoints', async () => {
    const res = await fetch(`${baseUrl}/api/words`);
    expect(res.status).toBe(401);
  });

  it('registers user with CEFR level, issues JWT, seeds level-matched words with real photos, and blocks admin routes', async () => {
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Тест Студент',
        email: 'student@test.io',
        password: 'password123',
        cefrLevel: 'C1',
      }),
    });
    expect(regRes.status).toBe(201);
    const regBody = (await regRes.json()) as {
      token: string;
      user: { role: string; cefr_level: string };
    };
    expect(regBody.token).toBeTruthy();
    expect(regBody.user.role).toBe('user');
    expect(regBody.user.cefr_level).toBe('C1');

    // Starter words should match C1 and carry verified Wikimedia photos
    const wordsRes = await fetch(`${baseUrl}/api/words`, {
      headers: { Authorization: `Bearer ${regBody.token}` },
    });
    expect(wordsRes.status).toBe(200);
    const wordsBody = (await wordsRes.json()) as {
      words: Array<{ word: string; cefr_level: string; image_url: string }>;
    };
    expect(wordsBody.words.length).toBeGreaterThanOrEqual(6);
    expect(wordsBody.words.every((w) => w.cefr_level === 'C1')).toBe(true);
    expect(wordsBody.words.every((w) => w.image_url.startsWith('https://'))).toBe(true);

    // Regular user cannot access /api/admin/overview
    const adminRes = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${regBody.token}` },
    });
    expect(adminRes.status).toBe(403);
  });

  it('blocks duplicate registrations on the same email (case, spaces, Gmail dots/+aliases) and supports clean login', async () => {
    const first = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'neka',
        email: 'Neka.User@gmail.com',
        password: 'password123',
      }),
    });
    expect(first.status).toBe(201);

    const dupExact = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Another',
        email: '  neka.user@gmail.com  ',
        password: 'password123',
      }),
    });
    expect(dupExact.status).toBe(409);

    const dupDotsAndTag = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Another2',
        email: 'nekauser+work@gmail.com',
        password: 'password123',
      }),
    });
    expect(dupDotsAndTag.status).toBe(409);

    // Login works by email AND by shared name with matching password
    const loginByName = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'neka', password: 'password123' }),
    });
    expect(loginByName.status).toBe(200);
  });

  it('allows user neka to login with password, review flashcard with FSRS, and earn XP', async () => {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'neka', password: 'Nekajon1608' }),
    });
    expect(loginRes.status).toBe(200);
    const { token, user } = (await loginRes.json()) as { token: string; user: { xp: number } };

    const queueRes = await fetch(`${baseUrl}/api/study/queue`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { queue } = (await queueRes.json()) as {
      queue: Array<{ id: number; image_url: string; intervalPreviews: Record<number, string> }>;
    };
    expect(queue.length).toBeGreaterThan(0);
    expect(queue[0].image_url.startsWith('https://')).toBe(true);
    expect(queue[0].intervalPreviews[3]).toBeTruthy();

    const reviewRes = await fetch(`${baseUrl}/api/study/review`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ wordId: queue[0].id, quality: 3 }),
    });
    expect(reviewRes.status).toBe(200);
    const reviewBody = (await reviewRes.json()) as {
      xpEarned: number;
      userStats: { xp: number };
      fsrs: { stability: number; difficulty: number; state: number };
    };
    expect(reviewBody.xpEarned).toBe(15);
    expect(reviewBody.userStats.xp).toBeGreaterThan(user.xp);
    expect(reviewBody.fsrs.stability).toBeGreaterThan(0);
    expect(reviewBody.fsrs.difficulty).toBeGreaterThan(0);

    // TTS endpoint requires auth and validates query text
    const unauthTts = await fetch(`${baseUrl}/api/audio/tts?text=improve`);
    expect(unauthTts.status).toBe(401);

    const emptyTts = await fetch(`${baseUrl}/api/audio/tts?text=`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(emptyTts.status).toBe(400);
  });

  it('rejects wrong password and allows nekaadmin with Nekajon1608 to access admin routes', async () => {
    const badLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nekaadmin', password: 'wrongpassword' }),
    });
    expect(badLoginRes.status).toBe(401);

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nekaadmin', password: 'Nekajon1608' }),
    });
    expect(loginRes.status).toBe(200);
    const { token } = (await loginRes.json()) as { token: string };

    const overviewRes = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(overviewRes.status).toBe(200);
    const overview = (await overviewRes.json()) as { stats: { totalUsers: number } };
    expect(overview.stats.totalUsers).toBeGreaterThanOrEqual(2);

    const broadcastRes = await fetch(`${baseUrl}/api/admin/broadcast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ title: 'Обновление', message: 'Добавлены новые карточки C1' }),
    });
    expect(broadcastRes.status).toBe(201);
  });

  it('validates input on bidirectional translation endpoints', async () => {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'neka', password: 'Nekajon1608' }),
    });
    const { token } = (await loginRes.json()) as { token: string };

    const promptRes = await fetch(`${baseUrl}/api/practice/translation-prompt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ targetWords: [], direction: 'ru_to_en' }),
    });
    expect(promptRes.status).toBe(400);

    const checkRes = await fetch(`${baseUrl}/api/practice/translation-check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ direction: 'en_to_ru', sourceSentence: '', userTranslation: '' }),
    });
    expect(checkRes.status).toBe(400);

    const localCheckRes = await fetch(`${baseUrl}/api/practice/translation-check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        direction: 'ru_to_en',
        sourceSentence: 'Мне нужно улучшить английский.',
        userTranslation: 'I need to improve my English.',
        targetWords: ['improve'],
        localFallback: true,
      }),
    });
    expect(localCheckRes.status).toBe(201);
    const localBody = (await localCheckRes.json()) as {
      feedback: { usedTargetWordsCorrectly: boolean; aiGenerated: boolean };
    };
    expect(localBody.feedback.usedTargetWordsCorrectly).toBe(true);
    expect(localBody.feedback.aiGenerated).toBe(false);
  });

  it('converts raw Gemini 429 RESOURCE_EXHAUSTED JSON into clean Russian AiServiceError', async () => {
    const { toFriendlyAiError } = await import('../server/ai.ts');
    const raw429 = new Error(
      '{"error":{"code":429,"message":"You exceeded your current quota... Please retry in 22h46m6.735s.","status":"RESOURCE_EXHAUSTED"}}'
    );
    const friendly = toFriendlyAiError(raw429);
    expect(friendly.statusCode).toBe(429);
    expect(friendly.code).toBe('QUOTA_EXHAUSTED');
    expect(friendly.message).toContain('Дневной лимит бесплатных запросов Gemini API исчерпан');
    expect(friendly.message).toContain('Settings > Secrets');
    expect(friendly.message).not.toContain('RESOURCE_EXHAUSTED');
  });

  it('translates single added words and imported lists into Russian and attaches verified photos even without Gemini quota', async () => {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'neka', password: 'Nekajon1608' }),
    });
    const { token } = (await loginRes.json()) as { token: string };

    const realFetch = globalThis.fetch;
    const prevKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith(baseUrl)) {
        return realFetch(input, init);
      }
      if (url.includes('api.dictionaryapi.dev')) {
        const w = decodeURIComponent(url.split('/').pop() || 'word');
        return new Response(
          JSON.stringify([
            {
              word: w,
              phonetic: `/${w}/`,
              meanings: [
                {
                  partOfSpeech: w === 'achieve' ? 'verb' : 'noun',
                  definitions: [
                    {
                      definition: `Definition of ${w}`,
                      example: `I saw a ${w} in the morning.`,
                    },
                  ],
                },
              ],
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('translate.googleapis.com/translate_a/single')) {
        const u = new URL(url);
        const q = (u.searchParams.get('q') || '').toLowerCase();
        if (q === 'apple') {
          return new Response(
            JSON.stringify([[['Яблоко', 'apple']], [['имя существительное', ['яблоко', 'яблоня']]]]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (q === 'achieve') {
          return new Response(
            JSON.stringify([[['достигать', 'achieve']], [['глагол', ['достигать', 'добиваться']]]]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (q === 'mountain') {
          return new Response(
            JSON.stringify([[['гора', 'mountain']], [['имя существительное', ['гора']]]]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        const lineCount = q.split('\n').length;
        const mockBatch = Array.from({ length: lineCount }, () => 'Утром я увидел интересный пример.').join('\n');
        return new Response(
          JSON.stringify([[[mockBatch, q]]]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('en.wikipedia.org/api/rest_v1/page/summary/')) {
        return new Response(
          JSON.stringify({
            type: 'standard',
            description: 'Edible fruit',
            thumbnail: {
              source: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/a6/Pink_lady_and_cross_section.jpg/330px-Pink_lady_and_cross_section.jpg',
              width: 330,
              height: 240,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (init?.method === 'HEAD' && url.includes('/thumb/')) {
        return new Response(null, { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
      }
      if (url.includes('api.openverse.org/v1/images/')) {
        return new Response(
          JSON.stringify({
            results: [
              {
                title: 'Mountain sunrise',
                thumbnail: 'https://api.openverse.org/v1/images/c0281003-3c63-46f2-aeaf-959604ec87a4/thumb/',
                width: 1024,
                height: 576,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });

    try {
      const addRes = await fetch(`${baseUrl}/api/words`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ word: 'apple' }),
      });
      expect(addRes.status).toBe(201);
      const addBody = (await addRes.json()) as {
        word: { word: string; translation: string; example_ru: string; image_url: string };
      };
      expect(addBody.word.word).toBe('apple');
      expect(addBody.word.translation).toContain('яблоко');
      expect(/[а-яё]/i.test(addBody.word.example_ru)).toBe(true);
      expect(addBody.word.image_url).toContain('https://');

      const importRes = await fetch(`${baseUrl}/api/words/import`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          rawContent: 'achieve\nmountain',
          format: 'txt',
          deckTitle: 'Тестовый список',
        }),
      });
      expect(importRes.status).toBe(201);
      const importBody = (await importRes.json()) as { importedCount: number; deckId: number };
      expect(importBody.importedCount).toBe(2);

      const deckWordsRes = await fetch(`${baseUrl}/api/words?deckId=${importBody.deckId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const deckWords = ((await deckWordsRes.json()) as { words: Array<{ word: string; translation: string; example_ru: string; image_url: string }> }).words;
      const achieveRow = deckWords.find((w) => w.word === 'achieve');
      const mountainRow = deckWords.find((w) => w.word === 'mountain');
      expect(achieveRow?.translation).toContain('достигать');
      expect(/[а-яё]/i.test(achieveRow?.example_ru || '')).toBe(true);
      expect(mountainRow?.translation).toContain('гора');
      expect(mountainRow?.image_url).toContain('https://');
    } finally {
      fetchSpy.mockRestore();
      if (prevKey !== undefined) process.env.GEMINI_API_KEY = prevKey;
    }
  });

  it('filters low-frequency noise, respects partOfSpeech via clients5 dj=1, and survives HTML CAPTCHA pages cleanly', async () => {
    const { translateEnglishToRussian } = await import('../server/dictionary.ts');
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const u = new URL(url);
      const q = (u.searchParams.get('q') || '').toLowerCase();

      // Simulate CAPTCHA HTML page on translate.googleapis.com
      if (url.includes('translate.googleapis.com')) {
        return new Response('<html><head><title>Sorry...</title></head></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }

      if (url.includes('clients5.google.com/translate_a/single')) {
        if (q === 'apple-fruit-test') {
          return new Response(
            JSON.stringify({
              sentences: [{ trans: 'яблоко', orig: 'apple-fruit-test' }],
              dict: [
                {
                  pos: 'noun',
                  terms: ['яблоко', 'яблоня', 'чепуха', 'лесть'],
                  entry: [
                    { word: 'яблоко', score: 0.656 },
                    { word: 'яблоня', score: 0.022 },
                    { word: 'чепуха', score: 0.0001 },
                    { word: 'лесть', score: 0.0001 },
                  ],
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (q === 'watch-pos-test') {
          return new Response(
            JSON.stringify({
              sentences: [{ trans: 'часы', orig: 'watch-pos-test' }],
              dict: [
                {
                  pos: 'noun',
                  terms: ['часы', 'стража'],
                  entry: [
                    { word: 'часы', score: 0.35 },
                    { word: 'стража', score: 0.01 },
                  ],
                },
                {
                  pos: 'verb',
                  terms: ['смотреть', 'наблюдать', 'следить'],
                  entry: [
                    { word: 'смотреть', score: 0.45 },
                    { word: 'наблюдать', score: 0.3 },
                    { word: 'следить', score: 0.12 },
                  ],
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (q === 'captcha-word-test') {
          return new Response('<html><body>Sorry... automated queries</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          });
        }
      }

      return new Response(JSON.stringify({}), { status: 404 });
    });

    try {
      const appleRu = await translateEnglishToRussian('apple-fruit-test', 'noun');
      expect(appleRu).toBe('яблоко');
      expect(appleRu).not.toContain('чепуха');
      expect(appleRu).not.toContain('лесть');

      const watchVerbRu = await translateEnglishToRussian('watch-pos-test', 'verb');
      expect(watchVerbRu).toContain('смотреть');
      expect(watchVerbRu).toContain('наблюдать');
      expect(watchVerbRu).not.toContain('часы');

      const watchNounRu = await translateEnglishToRussian('watch-pos-test', 'noun');
      expect(watchNounRu).toBe('часы');

      // HTML CAPTCHA must fail gracefully without throwing SyntaxError
      const captchaResult = await translateEnglishToRussian('captcha-word-test');
      expect(captchaResult).toBe('');
    } finally {
      spy.mockRestore();
    }
  });
});

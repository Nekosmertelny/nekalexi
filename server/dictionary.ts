export interface DictionaryLookupResult {
  word: string;
  phonetic: string;
  audioUrl: string;
  partOfSpeech: string;
  englishDefinition: string;
  englishExamples: string[];
  source: 'dictionaryapi' | 'fallback';
}

export interface ParsedWordEntry {
  word: string;
  translation?: string;
  partOfSpeech?: string;
  exampleEn?: string;
  exampleRu?: string;
}

export interface BilingualExamplePair {
  en: string;
  ru: string;
}

/**
 * Normalizes an English word or short expression before dictionary/translation lookup
 * by stripping edge quotes and sentence punctuation while preserving internal hyphens/apostrophes.
 */
export function normalizeWordForLookup(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'«»“”‘’`.,;:!?()[\]{}]+/, '')
    .replace(/["'«»“”‘’`.,;:!?()[\]{}]+$/, '')
    .trim();
}

/**
 * Fetches phonetic transcription, audio URL, part of speech, and definition
 * from the Free Dictionary API (https://api.dictionaryapi.dev).
 */
export async function lookupEnglishDictionary(
  rawWord: string,
  preferredPos?: string
): Promise<DictionaryLookupResult> {
  const cleanWord = normalizeWordForLookup(rawWord).toLowerCase();
  const targetPos = normalizePosTag(preferredPos);
  if (!cleanWord) {
    return {
      word: cleanWord,
      phonetic: '',
      audioUrl: '',
      partOfSpeech: targetPos || 'noun',
      englishDefinition: '',
      englishExamples: [],
      source: 'fallback',
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);
    const res = await fetch(
      `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(cleanWord)}`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);

    if (!res.ok) {
      throw new Error(`Dictionary API returned ${res.status}`);
    }

    const entries = (await res.json()) as Array<{
      word?: string;
      phonetic?: string;
      phonetics?: Array<{ text?: string; audio?: string }>;
      meanings?: Array<{
        partOfSpeech?: string;
        definitions?: Array<{ definition?: string; example?: string }>;
      }>;
    }>;

    const first = entries[0];
    if (!first) {
      throw new Error('Empty dictionary response');
    }

    const phonetic =
      first.phonetic ||
      first.phonetics?.find((p) => p.text)?.text ||
      '';
    const rawAudioUrl =
      first.phonetics?.find((p) => p.audio && p.audio.length > 0)?.audio || '';
    const audioUrl = rawAudioUrl.startsWith('//') ? `https:${rawAudioUrl}` : rawAudioUrl;

    const allMeanings = first.meanings || [];
    const orderedMeanings = targetPos
      ? [
          ...allMeanings.filter((m) => normalizePosTag(m.partOfSpeech) === targetPos),
          ...allMeanings.filter((m) => normalizePosTag(m.partOfSpeech) !== targetPos),
        ]
      : allMeanings;

    const firstMeaning = orderedMeanings[0];
    const partOfSpeech = firstMeaning?.partOfSpeech || targetPos || 'noun';
    const englishDefinition = firstMeaning?.definitions?.[0]?.definition || '';
    const englishExamples: string[] = [];

    for (const meaning of orderedMeanings) {
      for (const def of meaning.definitions || []) {
        if (def.example) {
          englishExamples.push(def.example);
          if (englishExamples.length >= 2) break;
        }
      }
      if (englishExamples.length >= 2) break;
    }

    return {
      word: first.word || cleanWord,
      phonetic,
      audioUrl,
      partOfSpeech,
      englishDefinition,
      englishExamples,
      source: 'dictionaryapi',
    };
  } catch {
    return {
      word: cleanWord,
      phonetic: '',
      audioUrl: '',
      partOfSpeech: targetPos || 'noun',
      englishDefinition: '',
      englishExamples: [],
      source: 'fallback',
    };
  }
}

const WIKIMEDIA_USER_AGENT = 'nekaLexi/1.0 (https://nekalexi.local; mailto:nekajon.nekka@gmail.com)';
const wordImageCache = new Map<string, string>();
const ruWordTranslationCache = new Map<string, string>();
const ruSentenceTranslationCache = new Map<string, string>();

const CYRILLIC_RE = /[а-яё]/i;

function normalizeSpaces(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function normalizePosTag(pos?: string): string {
  const low = (pos || '').trim().toLowerCase();
  if (!low) return '';
  if (low.includes('noun') || low.includes('существит')) return 'noun';
  if (low.includes('phrasal')) return 'verb';
  if (low.includes('verb') || low.includes('глагол')) return 'verb';
  if (low.includes('adj') || low.includes('прилагат')) return 'adjective';
  if (low.includes('adv') || low.includes('нареч')) return 'adverb';
  if (low.includes('prep') || low.includes('предлог')) return 'preposition';
  if (low.includes('conj') || low.includes('союз')) return 'conjunction';
  if (low.includes('pron') || low.includes('местоимен')) return 'pronoun';
  if (low.includes('interj') || low.includes('междомет')) return 'interjection';
  return low;
}

// Lightweight concurrency queue (max 2 in-flight requests to translation providers) to avoid burst throttling
let activeTranslateCount = 0;
const translateWaitQueue: Array<() => void> = [];

async function withTranslateSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeTranslateCount >= 2) {
    await new Promise<void>((resolve) => translateWaitQueue.push(resolve));
  }
  activeTranslateCount++;
  try {
    return await fn();
  } finally {
    activeTranslateCount--;
    const next = translateWaitQueue.shift();
    if (next) next();
  }
}

async function fetchJsonSafe(url: string, timeoutMs = 3000): Promise<unknown | null> {
  return withTranslateSlot(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        clearTimeout(timeout);
        if (res.ok) {
          const text = await res.text();
          const trimmed = text.trim();
          // Guard against HTML CAPTCHA ("Sorry...") or empty responses
          if (!trimmed || trimmed.startsWith('<')) {
            return null;
          }
          return JSON.parse(trimmed) as unknown;
        }
      } catch {
        // Retry once after short backoff
      }
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    return null;
  });
}

interface Clients5DictEntry {
  word?: string;
  score?: number;
}

interface Clients5DictGroup {
  pos?: string;
  terms?: string[];
  entry?: Clients5DictEntry[];
}

interface Clients5Response {
  sentences?: Array<{ trans?: string }>;
  dict?: Clients5DictGroup[];
}

function extractMeaningsFromClients5(
  data: Clients5Response,
  cleanWord: string,
  targetPos: string
): string[] {
  const sourceLower = cleanWord.toLowerCase();
  const isShortLookup = cleanWord.split(/\s+/).length <= 3;

  const meanings: string[] = [];
  const seen = new Set<string>();
  const addMeaning = (candidate: string) => {
    const normalized = normalizeSpaces(candidate)
      .replace(/[.,;:]+$/, '')
      .toLowerCase();
    if (!normalized || !CYRILLIC_RE.test(normalized)) return;
    if (normalized === sourceLower || seen.has(normalized)) return;
    // Skip overly long explanatory phrases in single-word dictionary badges
    if (isShortLookup && normalized.split(/\s+/).length > 4) return;
    seen.add(normalized);
    meanings.push(normalized);
  };

  const primaryRaw = Array.isArray(data.sentences)
    ? data.sentences.map((s) => (typeof s?.trans === 'string' ? s.trans : '')).join('').trim()
    : '';

  if (isShortLookup && Array.isArray(data.dict) && data.dict.length > 0) {
    const matchingGroups = targetPos
      ? data.dict.filter((g) => normalizePosTag(g.pos) === targetPos)
      : [];
    const groupsToInspect = matchingGroups.length > 0 ? matchingGroups : data.dict;

    const candidates: Array<{ word: string; score: number }> = [];
    const groupTermsLower = new Set<string>();
    for (const group of groupsToInspect) {
      if (Array.isArray(group.terms)) {
        for (const t of group.terms) {
          if (typeof t === 'string') groupTermsLower.add(normalizeSpaces(t).toLowerCase());
        }
      }
      if (Array.isArray(group.entry) && group.entry.length > 0) {
        for (const e of group.entry) {
          if (typeof e?.word === 'string' && CYRILLIC_RE.test(e.word)) {
            groupTermsLower.add(normalizeSpaces(e.word).toLowerCase());
            candidates.push({ word: e.word, score: typeof e.score === 'number' ? e.score : 0 });
          }
        }
      } else if (Array.isArray(group.terms)) {
        for (const t of group.terms.slice(0, 3)) {
          if (typeof t === 'string' && CYRILLIC_RE.test(t)) {
            candidates.push({ word: t, score: 0.1 });
          }
        }
      }
    }

    const primaryNorm = primaryRaw ? normalizeSpaces(primaryRaw).replace(/[.,;:]+$/, '').toLowerCase() : '';
    const primaryMatchesPos =
      Boolean(primaryNorm) &&
      (matchingGroups.length === 0 || data.dict.length === 1 || groupTermsLower.has(primaryNorm));

    if (primaryMatchesPos && primaryNorm) {
      addMeaning(primaryNorm);
    }

    if (candidates.length > 0) {
      candidates.sort((a, b) => b.score - a.score);
      const topScore = candidates[0].score;
      const minThreshold = topScore >= 0.02 ? topScore * 0.25 : topScore * 0.15;

      for (const c of candidates) {
        if (meanings.length === 0 || c.score >= minThreshold) {
          addMeaning(c.word);
        }
        if (meanings.length >= 3) break;
      }
    }

    if (meanings.length === 0 && primaryRaw) {
      addMeaning(primaryRaw);
    }
  } else if (primaryRaw) {
    addMeaning(primaryRaw);
  }

  return meanings.slice(0, 3);
}

function extractMeaningsFromGtxArray(
  data: unknown[],
  cleanWord: string,
  targetPos: string
): string[] {
  const sourceLower = cleanWord.toLowerCase();
  const isShortLookup = cleanWord.split(/\s+/).length <= 3;

  const meanings: string[] = [];
  const seen = new Set<string>();
  const addMeaning = (candidate: string) => {
    const normalized = normalizeSpaces(candidate)
      .replace(/[.,;:]+$/, '')
      .toLowerCase();
    if (!normalized || !CYRILLIC_RE.test(normalized)) return;
    if (normalized === sourceLower || seen.has(normalized)) return;
    seen.add(normalized);
    meanings.push(normalized);
  };

  const chunks = Array.isArray(data[0]) ? (data[0] as unknown[][]) : [];
  const primaryRaw = chunks
    .map((c) => (Array.isArray(c) && typeof c[0] === 'string' ? c[0] : ''))
    .join('')
    .trim();

  if (isShortLookup && Array.isArray(data[1])) {
    const dictGroups = data[1] as unknown[][];
    const matchingGroups = targetPos
      ? dictGroups.filter((g) => Array.isArray(g) && normalizePosTag(String(g[0] || '')) === targetPos)
      : [];
    const groupsToInspect = matchingGroups.length > 0 ? matchingGroups : dictGroups;

    const scoredCandidates: Array<{ word: string; score: number }> = [];
    for (const group of groupsToInspect) {
      if (!Array.isArray(group)) continue;
      if (Array.isArray(group[2])) {
        for (const entry of group[2] as unknown[][]) {
          if (Array.isArray(entry) && typeof entry[0] === 'string' && CYRILLIC_RE.test(entry[0])) {
            const score = typeof entry[3] === 'number' ? entry[3] : 0;
            scoredCandidates.push({ word: entry[0], score });
          }
        }
      } else if (Array.isArray(group[1])) {
        for (const term of (group[1] as unknown[]).slice(0, 3)) {
          if (typeof term === 'string' && CYRILLIC_RE.test(term)) {
            scoredCandidates.push({ word: term, score: 0.1 });
          }
        }
      }
    }

    if (scoredCandidates.length > 0) {
      scoredCandidates.sort((a, b) => b.score - a.score);
      const topScore = scoredCandidates[0].score;
      const minThreshold = topScore > 0 ? Math.max(0.04, topScore * 0.25) : 0;
      for (const c of scoredCandidates) {
        if (meanings.length === 0 || c.score >= minThreshold) {
          addMeaning(c.word);
        }
        if (meanings.length >= 3) break;
      }
    }
  }

  if (primaryRaw && (meanings.length === 0 || !targetPos)) {
    const prev = [...meanings];
    meanings.length = 0;
    seen.clear();
    addMeaning(primaryRaw);
    for (const m of prev) {
      if (meanings.length >= 3) break;
      addMeaning(m);
    }
  }

  return meanings.slice(0, 3);
}

async function translateViaRuWiktionary(cleanWord: string): Promise<string> {
  if (cleanWord.includes(' ')) return '';
  try {
    const url =
      `https://ru.wiktionary.org/w/api.php?action=query&titles=${encodeURIComponent(cleanWord.toLowerCase())}` +
      `&prop=extracts&explaintext=1&format=json`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2200);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': WIKIMEDIA_USER_AGENT },
    });
    clearTimeout(timer);
    if (!res.ok) return '';
    const data = (await res.json()) as {
      query?: { pages?: Record<string, { extract?: string }> };
    };
    const page = Object.values(data.query?.pages || {})[0];
    const extract = page?.extract || '';
    const sectionMatch = extract.match(/====\s*Значение\s*====\s*([\s\S]*?)(?:\n===|$)/i);
    if (!sectionMatch) return '';
    const lines = sectionMatch[1]
      .split(/\r?\n/)
      .map((l) => l.replace(/◆.*$/, '').replace(/\[[^\]]*\]/g, '').trim())
      .filter((l) => l.length > 0 && CYRILLIC_RE.test(l));
    const glosses: string[] = [];
    for (const line of lines) {
      const firstPart = line.split(/[;,.]/)[0]?.trim().toLowerCase();
      if (firstPart && CYRILLIC_RE.test(firstPart) && firstPart.split(/\s+/).length <= 3) {
        if (!glosses.includes(firstPart)) glosses.push(firstPart);
      }
      if (glosses.length >= 2) break;
    }
    return glosses.join(', ');
  } catch {
    return '';
  }
}

/**
 * Translates an English word or short phrase into concise, high-frequency Russian meanings (1-3 variants)
 * with part-of-speech prioritization and multi-endpoint CAPTCHA resilience.
 */
export async function translateEnglishToRussian(
  rawWord: string,
  partOfSpeech?: string
): Promise<string> {
  const cleanWord = normalizeWordForLookup(rawWord);
  if (!cleanWord) return '';
  if (CYRILLIC_RE.test(cleanWord)) return cleanWord;

  const normalizedPos = normalizePosTag(partOfSpeech);
  const cacheKey = `${cleanWord.toLowerCase()}::${normalizedPos}`;
  const cached = ruWordTranslationCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let meanings: string[] = [];

  // Tier 1: Chrome extension dictionary endpoint with frequency scores & POS breakdown (no CAPTCHA throttling)
  const clients5Url =
    `https://clients5.google.com/translate_a/single?dj=1&dt=t&dt=bd&client=dict-chrome-ex&sl=en&tl=ru&q=` +
    encodeURIComponent(cleanWord);
  const c5Data = await fetchJsonSafe(clients5Url);
  if (c5Data && !Array.isArray(c5Data) && typeof c5Data === 'object') {
    meanings = extractMeaningsFromClients5(c5Data as Clients5Response, cleanWord, normalizedPos);
  } else if (Array.isArray(c5Data)) {
    meanings = extractMeaningsFromGtxArray(c5Data, cleanWord, normalizedPos);
  }

  // Tier 2: clients5 compact /t endpoint fallback
  if (meanings.length === 0) {
    const tUrl =
      `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=ru&q=` +
      encodeURIComponent(cleanWord);
    const tData = await fetchJsonSafe(tUrl);
    if (Array.isArray(tData)) {
      const flatText = typeof tData[0] === 'string'
        ? tData[0]
        : Array.isArray(tData[0]) && typeof tData[0][0] === 'string'
        ? tData[0][0]
        : '';
      const candidate = normalizeSpaces(flatText).replace(/[.,;:]+$/, '').toLowerCase();
      if (candidate && CYRILLIC_RE.test(candidate) && candidate !== cleanWord.toLowerCase()) {
        meanings = [candidate];
      }
    }
  }

  // Tier 3: translate.googleapis.com gtx fallback
  if (meanings.length === 0) {
    const gtxUrl =
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ru&dt=t&dt=bd&q=` +
      encodeURIComponent(cleanWord);
    const gtxData = await fetchJsonSafe(gtxUrl);
    if (Array.isArray(gtxData)) {
      meanings = extractMeaningsFromGtxArray(gtxData, cleanWord, normalizedPos);
    }
  }

  // Tier 4: Russian Wiktionary fallback for single English words
  let result = meanings.slice(0, 3).join(', ');
  if (!result) {
    result = await translateViaRuWiktionary(cleanWord);
  }

  if (result) {
    if (ruWordTranslationCache.size > 600) ruWordTranslationCache.clear();
    ruWordTranslationCache.set(cacheKey, result);
  }
  return result;
}

function extractSentenceTranslationFromJson(data: unknown): string {
  if (!data) return '';
  if (!Array.isArray(data) && typeof data === 'object') {
    const obj = data as Clients5Response;
    if (Array.isArray(obj.sentences)) {
      return obj.sentences.map((s) => (typeof s?.trans === 'string' ? s.trans : '')).join('');
    }
  }
  if (Array.isArray(data)) {
    if (typeof data[0] === 'string') return data[0];
    if (Array.isArray(data[0])) {
      return (data[0] as unknown[])
        .map((c) => (Array.isArray(c) && typeof c[0] === 'string' ? c[0] : typeof c === 'string' ? c : ''))
        .join('');
    }
  }
  return '';
}

/**
 * Translates multiple English sentences into Russian in a single HTTP request.
 */
export async function translateSentencesBatchEnToRu(sentences: string[]): Promise<string[]> {
  const cleaned = sentences.map((s) => s.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim());
  const results = new Array<string>(cleaned.length).fill('');
  const missingIndexes: number[] = [];

  for (let i = 0; i < cleaned.length; i++) {
    const s = cleaned[i];
    if (!s) continue;
    if (CYRILLIC_RE.test(s)) {
      results[i] = s;
      continue;
    }
    const cached = ruSentenceTranslationCache.get(s.toLowerCase());
    if (cached !== undefined) {
      results[i] = cached;
    } else {
      missingIndexes.push(i);
    }
  }

  if (missingIndexes.length === 0) return results;

  const batchText = missingIndexes.map((idx) => cleaned[idx]).join('\n');
  const endpoints = [
    `https://clients5.google.com/translate_a/single?dj=1&dt=t&client=dict-chrome-ex&sl=en&tl=ru&q=${encodeURIComponent(batchText)}`,
    `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ru&dt=t&q=${encodeURIComponent(batchText)}`,
  ];

  for (const url of endpoints) {
    const data = await fetchJsonSafe(url);
    const joined = extractSentenceTranslationFromJson(data);
    if (!joined) continue;
    const lines = joined.split(/\r?\n/);
    if (lines.length === missingIndexes.length) {
      for (let j = 0; j < missingIndexes.length; j++) {
        const idx = missingIndexes[j];
        const translated = normalizeSpaces(lines[j] || '');
        if (translated && CYRILLIC_RE.test(translated)) {
          if (ruSentenceTranslationCache.size > 600) ruSentenceTranslationCache.clear();
          ruSentenceTranslationCache.set(cleaned[idx].toLowerCase(), translated);
          results[idx] = translated;
        }
      }
      return results;
    }
  }

  // Fallback per-sentence sequentially if newline splitting didn't align
  for (const idx of missingIndexes) {
    if (!results[idx]) {
      results[idx] = await translateSentenceEnToRu(cleaned[idx]);
    }
  }
  return results;
}

/**
 * Translates a full English example sentence into natural Russian.
 */
export async function translateSentenceEnToRu(sentence: string): Promise<string> {
  const clean = normalizeSpaces(sentence);
  if (!clean) return '';
  if (CYRILLIC_RE.test(clean)) return clean;

  const cacheKey = clean.toLowerCase();
  const cached = ruSentenceTranslationCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const endpoints = [
    `https://clients5.google.com/translate_a/single?dj=1&dt=t&client=dict-chrome-ex&sl=en&tl=ru&q=${encodeURIComponent(clean)}`,
    `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=ru&q=${encodeURIComponent(clean)}`,
    `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ru&dt=t&q=${encodeURIComponent(clean)}`,
  ];

  for (const url of endpoints) {
    const data = await fetchJsonSafe(url);
    const translated = normalizeSpaces(extractSentenceTranslationFromJson(data));
    if (translated && CYRILLIC_RE.test(translated)) {
      if (ruSentenceTranslationCache.size > 600) ruSentenceTranslationCache.clear();
      ruSentenceTranslationCache.set(cacheKey, translated);
      return translated;
    }
  }

  return '';
}

/**
 * Fetches authentic human-translated English->Russian example sentence pairs from Tatoeba.
 */
export async function lookupTatoebaExamples(rawWord: string): Promise<BilingualExamplePair[]> {
  const cleanWord = normalizeWordForLookup(rawWord);
  if (!cleanWord) return [];
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1400);
    const url =
      `https://tatoeba.org/en/api_v0/search?from=eng&to=rus&query=${encodeURIComponent(cleanWord)}&limit=4`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': WIKIMEDIA_USER_AGENT },
    });
    clearTimeout(timer);
    if (!res.ok) return [];

    const data = (await res.json()) as {
      results?: Array<{
        text?: string;
        translations?: Array<Array<{ lang?: string; text?: string }> | { lang?: string; text?: string }>;
      }>;
    };

    const stem = cleanWord.toLowerCase().slice(0, Math.max(3, cleanWord.length - 1));
    const pairs: BilingualExamplePair[] = [];
    const seenEn = new Set<string>();

    for (const item of data.results || []) {
      const en = normalizeSpaces(item.text || '');
      if (!en || en.length > 120 || !en.toLowerCase().includes(stem)) continue;

      const flatTranslations: Array<{ lang?: string; text?: string }> = [];
      for (const tGroup of item.translations || []) {
        if (Array.isArray(tGroup)) {
          flatTranslations.push(...tGroup);
        } else if (tGroup && typeof tGroup === 'object') {
          flatTranslations.push(tGroup);
        }
      }

      const ruObj = flatTranslations.find(
        (t) =>
          (t.lang === 'rus' || !t.lang) &&
          typeof t.text === 'string' &&
          CYRILLIC_RE.test(t.text) &&
          t.text.length <= 140
      );
      if (!ruObj?.text) continue;
      const ru = normalizeSpaces(ruObj.text);
      const enKey = en.toLowerCase();
      if (seenEn.has(enKey)) continue;
      seenEn.add(enKey);
      pairs.push({ en, ru });
      if (pairs.length >= 2) break;
    }

    return pairs;
  } catch {
    return [];
  }
}

export interface LookupWordImageOptions {
  partOfSpeech?: string;
  englishDefinition?: string;
  hintQuery?: string;
  excludeUrls?: string[];
}

const BAD_IMAGE_KEYWORDS_RE =
  /(\.svg|diagram|chart|graph|screenshot|logo|flag|coat[_ ]of[_ ]arms|emblem|map[_.]|poster|flyer|sheet[_ ]music|tombstone|grave|monument[_ ]plaque|scan|document|cartoon|meme|mugshot|icon|watermark|1[5-9]\d\d|amateur|sexy|babe|lingerie|bikini|nude|erotic|glamour|boudoir|fetish|nsfw|playboy|penthouse|etching|engraving|lithograph|woodcut|oil[_ ]on[_ ]canvas|fresco|caricature|plate[_ ]\d+|disasters[_ ]of[_ ]war|met[_ ]mm\d+)/i;

const BAD_WIKI_TOPIC_RE =
  /(\bdisambiguation\b|\bsurname\b|\bgiven name\b|\bborn \d{4}\b|\bpolitician\b|\bactor\b|\bactress\b|\bsinger\b|\brapper\b|\bfootballer\b|\bathlete\b|\bcomposer\b|\bmonarch\b|\bpresident\b|\bfilm\b|\bmovie\b|\btelevision\b|\balbum\b|\bsong\b|\bband\b|\bmusician\b|\bnovel\b|\bvideo game\b|\banime\b|\bmanga\b|\bcompany\b|\bcorporation\b|\bsoftware\b|\bstartup\b|\bmunicipality\b|\bvillage\b|\bcounty\b|\bcity in\b|\btown in\b|\bpainting\b|\betching\b|\bengraving\b|\bsculpture\b)/i;

const CONTEXTUAL_VISUAL_HINTS: Record<string, string> = {
  achieve: 'trophy medal',
  ambiguous: 'foggy forest path',
  ambition: 'mountain summit',
  anxiety: 'stressed desk',
  borrow: 'library books',
  challenge: 'mountain climbing',
  collaborate: 'team meeting',
  comfortable: 'cozy armchair',
  confidence: 'public speaker stage',
  confident: 'speaker podium',
  courage: 'rock climbing',
  creativity: 'artist studio',
  curiosity: 'magnifying glass',
  deadline: 'calendar clock',
  decide: 'crossroads',
  discipline: 'morning running',
  efficient: 'high speed train',
  eloquent: 'public speaking',
  ephemeral: 'cherry blossom',
  experience: 'mountain hiking',
  explain: 'classroom teacher',
  explore: 'hiking map',
  focus: 'desk study',
  freedom: 'open sky bird',
  goal: 'target archery',
  habit: 'morning coffee notebook',
  happy: 'kid smiling',
  improve: 'study notebook',
  knowledge: 'library books',
  'look forward to': 'boarding pass',
  memory: 'photo album',
  mistake: 'eraser pencil',
  motivation: 'runner sunrise',
  negotiate: 'handshake',
  opportunity: 'open door',
  patience: 'hourglass sand',
  perseverance: 'mountain climbing',
  perspective: 'city perspective',
  pragmatic: 'checklist',
  prepare: 'desk notebooks',
  progress: 'stairs climbing',
  reliable: 'watch movement',
  resilient: 'succulent rock',
  schedule: 'calendar planner',
  scrutinize: 'magnifying glass',
  solution: 'puzzle piece',
  success: 'graduation celebration',
  suggest: 'light bulb',
  sustainable: 'wind turbines',
  travel: 'suitcase travel',
  ubiquitous: 'smartphone cafe',
  wisdom: 'owl library',
};

const STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as', 'into', 'or', 'and',
  'is', 'are', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'make', 'makes', 'made',
  'get', 'give', 'take', 'come', 'go', 'something', 'someone', 'anything', 'anyone', 'person', 'people',
  'thing', 'things', 'way', 'state', 'quality', 'act', 'action', 'process', 'having', 'using', 'used',
  'very', 'more', 'most', 'able', 'capable', 'such', 'other', 'one', 'two', 'often', 'usually', 'especially',
]);

function extractDefinitionVisualKeywords(definition?: string): string {
  if (!definition) return '';
  const tokens = definition
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  return Array.from(new Set(tokens)).slice(0, 2).join(' ');
}

function isAcceptableRealPhotoUrl(url: string): boolean {
  if (!url || !url.startsWith('https://')) return false;
  if (BAD_IMAGE_KEYWORDS_RE.test(url)) return false;
  const lower = url.toLowerCase();
  if (lower.includes('.pdf') || lower.includes('.ogg') || lower.includes('.webm')) {
    return false;
  }
  return (
    lower.includes('upload.wikimedia.org') ||
    lower.includes('thumb.wikimedia.org') ||
    lower.includes('api.openverse.org')
  );
}

async function verifyImageUrlLoads(url: string, timeoutMs = 1100): Promise<boolean> {
  if (!url || !url.startsWith('https://')) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      headers: { 'User-Agent': WIKIMEDIA_USER_AGENT },
    });
    clearTimeout(timer);
    if (!res.ok) return false;
    const ct = res.headers.get('content-type') || '';
    return ct.startsWith('image/') && !ct.includes('svg');
  } catch {
    return false;
  }
}

async function fetchWikipediaExactPhoto(
  query: string,
  excludeSet: Set<string>
): Promise<string> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1600);
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': WIKIMEDIA_USER_AGENT },
    });
    clearTimeout(timeout);
    if (!res.ok) return '';

    const data = (await res.json()) as {
      type?: string;
      description?: string;
      extract?: string;
      thumbnail?: { source?: string; width?: number; height?: number };
    };

    if (data.type !== 'standard') return '';
    const topicText = `${data.description || ''} ${data.extract || ''}`;
    if (BAD_WIKI_TOPIC_RE.test(topicText)) return '';

    const rawSrc = data.thumbnail?.source || '';
    const src = rawSrc.split('?')[0];
    if (!src || excludeSet.has(src)) return '';
    if (!isAcceptableRealPhotoUrl(src)) return '';
    if ((data.thumbnail?.width ?? 0) < 240) return '';
    return src;
  } catch {
    return '';
  }
}

interface OpenverseCandidate {
  title?: string;
  url?: string;
  thumbnail?: string;
  width?: number;
  height?: number;
  tags?: Array<{ name?: string }>;
}

async function fetchOpenversePhoto(
  matchTerms: string[],
  query: string,
  excludeSet: Set<string>
): Promise<string> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2200);
    const url =
      `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}` +
      `&category=photograph&page_size=15&mature=false`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': WIKIMEDIA_USER_AGENT },
    });
    clearTimeout(timeout);
    if (!res.ok) return '';

    const data = (await res.json()) as { results?: OpenverseCandidate[] };
    const results = Array.isArray(data.results) ? data.results : [];
    const normalizedTerms = Array.from(
      new Set(matchTerms.map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 3))
    );
    const queryWords = Array.from(
      new Set(query.trim().toLowerCase().split(/\s+/).filter((t) => t.length >= 3))
    );
    const termRegexes = normalizedTerms.map(
      (t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i')
    );
    const queryWordRegexes = queryWords.map(
      (t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i')
    );

    const scored = results
      .map((item) => {
        const candidateUrl = (item.thumbnail || '').startsWith('https://')
          ? item.thumbnail!
          : (item.url || '').startsWith('https://')
          ? item.url!
          : '';
        if (!candidateUrl || excludeSet.has(candidateUrl)) return null;
        if (BAD_IMAGE_KEYWORDS_RE.test(candidateUrl)) return null;

        const title = (item.title || '').trim();
        const tagText = (item.tags || []).map((t) => t.name || '').join(' ');
        if (BAD_IMAGE_KEYWORDS_RE.test(`${title} ${tagText}`)) return null;
        // Reject noisy Flickr diary/spam titles
        if (title.length > 90 || title.includes('//') || title.includes(':-)') || title.includes('!')) {
          return null;
        }
        if ((item.width ?? 640) < 320 || (item.height ?? 480) < 220) return null;

        const titleMatches = termRegexes.filter((re) => re.test(title)).length;
        const tagMatches = termRegexes.filter((re) => re.test(tagText)).length;
        const queryCombinedMatches = queryWordRegexes.filter(
          (re) => re.test(title) || re.test(tagText)
        ).length;

        // STRICT RELEVANCE GATE:
        // 1) Title or tags must match at least one target term
        if (titleMatches === 0 && tagMatches === 0) return null;
        // 2) Multi-word visual queries (e.g. "trophy medal", "hiking map") must match >= 2 query words
        //    unless the title directly matches the exact word/phrase
        if (queryWords.length >= 2 && queryCombinedMatches < 2 && titleMatches < 2) return null;
        // 3) Single-word queries require an actual title match (prevents off-topic Flickr tag dumps)
        if (queryWords.length === 1 && titleMatches === 0) return null;
        // 4) Reject generic camera filenames like DSC_0083 unless tags strongly match
        if (/^(img|dsc|pxl|photo|image)[_-]?\d+/i.test(title) && tagMatches < 2) return null;
        // 5) Reject personal portraits unless query explicitly asks for portrait/speaker/person
        if (/^[A-Z][a-z]+ [A-Z][a-z]+$/.test(title) && titleMatches === 0) return null;

        let score = titleMatches * 6 + queryCombinedMatches * 4 + tagMatches * 2;
        if (normalizedTerms.some((t) => title.toLowerCase() === t)) score += 6;
        if (title.toLowerCase().includes(query.trim().toLowerCase())) score += 8;
        if ((item.width ?? 0) > (item.height ?? 0)) score += 2;
        if (item.thumbnail) score += 1;

        return { url: candidateUrl, score };
      })
      .filter((x): x is { url: string; score: number } => x !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    if (scored.length === 0) return '';

    // Verify top candidates return HTTP 200 image/* in parallel so cards never show broken images
    const checks = await Promise.all(
      scored.map(async (c) => ((await verifyImageUrlLoads(c.url)) ? c.url : ''))
    );
    return checks.find(Boolean) || '';
  } catch {
    return '';
  }
}

async function fetchWikimediaCommonsFallback(
  query: string,
  excludeSet: Set<string>
): Promise<string> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1800);
    const commonsUrl =
      `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6` +
      `&gsrsearch=${encodeURIComponent(`filetype:bitmap ${query}`)}&gsrlimit=5` +
      `&prop=imageinfo&iiprop=url|mime|size&iiurlwidth=640&format=json`;
    const res = await fetch(commonsUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': WIKIMEDIA_USER_AGENT },
    });
    clearTimeout(timeout);
    if (!res.ok) return '';

    const data = (await res.json()) as {
      query?: {
        pages?: Record<
          string,
          {
            index?: number;
            title?: string;
            imageinfo?: Array<{ thumburl?: string; url?: string; mime?: string; width?: number }>;
          }
        >;
      };
    };
    const pages = Object.values(data.query?.pages || {}).sort(
      (a, b) => (a.index ?? 99) - (b.index ?? 99)
    );
    for (const p of pages) {
      const info = p.imageinfo?.[0];
      const src = info?.thumburl || info?.url || '';
      const mime = info?.mime || '';
      if (
        src &&
        !excludeSet.has(src) &&
        !BAD_IMAGE_KEYWORDS_RE.test(p.title || '') &&
        isAcceptableRealPhotoUrl(src) &&
        ['image/jpeg', 'image/png', 'image/webp'].includes(mime) &&
        (info?.width ?? 0) >= 320
      ) {
        return src;
      }
    }
  } catch {
    // Ignore network/timeout errors
  }
  return '';
}

/**
 * Fetches a contextually relevant, non-AI photograph URL for an English word.
 * Combines Wikipedia Exact REST Summary + strictly title/tag-filtered Openverse search,
 * using partOfSpeech and English definition hints for abstract verbs/adjectives.
 */
export async function lookupWordImage(
  rawWord: string,
  hintOrOptions?: string | LookupWordImageOptions
): Promise<string> {
  const cleanWord = rawWord.trim().toLowerCase();
  if (!cleanWord) return '';

  const opts: LookupWordImageOptions =
    typeof hintOrOptions === 'string' ? { hintQuery: hintOrOptions } : hintOrOptions || {};
  const partOfSpeech = (opts.partOfSpeech || '').trim().toLowerCase();
  const hintQuery = (opts.hintQuery || '').trim().toLowerCase();
  const defKeywords = extractDefinitionVisualKeywords(opts.englishDefinition);
  const semanticScene = CONTEXTUAL_VISUAL_HINTS[cleanWord] || '';
  const excludeSet = new Set((opts.excludeUrls || []).filter(Boolean));

  const cacheKey = `${cleanWord}::${partOfSpeech}::${hintQuery}::${defKeywords}`;
  if (excludeSet.size === 0) {
    const cached = wordImageCache.get(cacheKey);
    if (cached !== undefined) return cached;
  }

  const primaryVisualQuery = hintQuery || semanticScene || cleanWord;
  const primaryMatchTerms = primaryVisualQuery.split(/\s+/);
  const canUseWikipedia = (!partOfSpeech || partOfSpeech === 'noun') && !semanticScene && !hintQuery;

  const [wikiSettled, openverseSettled] = await Promise.allSettled([
    canUseWikipedia ? fetchWikipediaExactPhoto(cleanWord, excludeSet) : Promise.resolve(''),
    fetchOpenversePhoto(
      semanticScene || hintQuery ? primaryMatchTerms : [...primaryMatchTerms, ...cleanWord.split(/\s+/)],
      primaryVisualQuery,
      excludeSet
    ),
  ]);

  const wikiPhoto = wikiSettled.status === 'fulfilled' ? wikiSettled.value : '';
  const openversePhoto = openverseSettled.status === 'fulfilled' ? openverseSettled.value : '';

  let chosen = canUseWikipedia ? wikiPhoto || openversePhoto : openversePhoto;

  // If raw word had no strict title/tag match, try definition-derived visual scene keywords
  if (!chosen && defKeywords && defKeywords !== primaryVisualQuery) {
    chosen = await fetchOpenversePhoto(defKeywords.split(/\s+/), defKeywords, excludeSet);
  }

  if (!chosen) {
    chosen = await fetchWikimediaCommonsFallback(primaryVisualQuery, excludeSet);
  }

  if (excludeSet.size === 0 && chosen) {
    if (wordImageCache.size > 400) wordImageCache.clear();
    wordImageCache.set(cacheKey, chosen);
  }
  return chosen;
}

/**
 * Parses custom uploaded word lists in JSON, CSV, or plain text formats.
 * Supports:
 * - JSON array of strings or { word, translation, partOfSpeech, exampleEn, exampleRu }
 * - CSV with headers or columns: word,translation,partOfSpeech,exampleEn,exampleRu
 * - Plain text lines: "ephemeral - недолговечный" or "ephemeral; мимолетный" or "ephemeral"
 */
export function parseWordListInput(rawContent: string, formatHint?: 'csv' | 'txt' | 'json'): ParsedWordEntry[] {
  const trimmed = rawContent.trim();
  if (!trimmed) return [];

  // Try JSON first if hinted or starts with [
  if (formatHint === 'json' || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item): ParsedWordEntry | null => {
            if (typeof item === 'string') {
              const w = item.trim();
              return w ? { word: w } : null;
            }
            if (item && typeof item === 'object' && typeof item.word === 'string') {
              return {
                word: item.word.trim(),
                translation: typeof item.translation === 'string' ? item.translation.trim() : undefined,
                partOfSpeech: typeof item.partOfSpeech === 'string' ? item.partOfSpeech.trim() : undefined,
                exampleEn: typeof item.exampleEn === 'string' ? item.exampleEn.trim() : undefined,
                exampleRu: typeof item.exampleRu === 'string' ? item.exampleRu.trim() : undefined,
              };
            }
            return null;
          })
          .filter((x): x is ParsedWordEntry => x !== null && x.word.length > 0);
      }
    } catch {
      // Fall through to line-by-line parsing
    }
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));

  const results: ParsedWordEntry[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip CSV header row
    if (i === 0 && /^word\s*[,;\t]/i.test(line)) {
      continue;
    }

    let word = '';
    let translation: string | undefined;
    let partOfSpeech: string | undefined;
    let exampleEn: string | undefined;
    let exampleRu: string | undefined;

    if (line.includes(',') || line.includes(';') || line.includes('\t')) {
      const sep = line.includes('\t') ? '\t' : line.includes(';') ? ';' : ',';
      const cols = splitCsvLine(line, sep);
      word = (cols[0] || '').trim();
      translation = cols[1]?.trim() || undefined;
      partOfSpeech = cols[2]?.trim() || undefined;
      exampleEn = cols[3]?.trim() || undefined;
      exampleRu = cols[4]?.trim() || undefined;
    } else if (/\s[-–—]\s/.test(line)) {
      const parts = line.split(/\s[-–—]\s/);
      word = parts[0].trim();
      translation = parts.slice(1).join(' - ').trim() || undefined;
    } else {
      word = line;
    }

    const key = word.toLowerCase();
    if (word && !seen.has(key)) {
      seen.add(key);
      results.push({ word, translation, partOfSpeech, exampleEn, exampleRu });
    }
  }

  return results;
}

function splitCsvLine(line: string, sep: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === sep && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result.map((s) => s.replace(/^"|"$/g, '').trim());
}

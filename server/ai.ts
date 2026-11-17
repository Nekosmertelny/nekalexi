import { GoogleGenAI, Type, ThinkingLevel, type GenerateContentParameters } from '@google/genai';
import {
  lookupTatoebaExamples,
  translateEnglishToRussian,
  translateSentencesBatchEnToRu,
  type DictionaryLookupResult,
} from './dictionary.ts';

const PRIMARY_MODEL = 'gemini-4-hydrogen';
const FALLBACK_MODEL = 'gemini-3.1-flash-lite';
const MODEL_COOLDOWN_MS = 10 * 60 * 1000;

const modelCooldownUntil = new Map<string, number>();
const lastQuotaErrorByModel = new Map<string, unknown>();

export class AiServiceError extends Error {
  statusCode: number;
  code: 'QUOTA_EXHAUSTED' | 'AUTH_ERROR' | 'MODEL_ERROR' | 'UNCONFIGURED';

  constructor(
    statusCode: number,
    code: 'QUOTA_EXHAUSTED' | 'AUTH_ERROR' | 'MODEL_ERROR' | 'UNCONFIGURED',
    message: string
  ) {
    super(message);
    this.name = 'AiServiceError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function getErrorRawMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function isQuotaError(err: unknown): boolean {
  const msg = getErrorRawMessage(err);
  const status = (err as { status?: number; code?: number })?.status ?? (err as { code?: number })?.code;
  return (
    status === 429 ||
    msg.includes('429') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.toLowerCase().includes('quota exceeded') ||
    msg.toLowerCase().includes('rate-limit')
  );
}

function isAuthError(err: unknown): boolean {
  const msg = getErrorRawMessage(err);
  const status = (err as { status?: number; code?: number })?.status ?? (err as { code?: number })?.code;
  return (
    status === 403 ||
    msg.includes('PERMISSION_DENIED') ||
    msg.includes('API_KEY_INVALID') ||
    msg.toLowerCase().includes('api key not valid')
  );
}

function isTransientError(err: unknown): boolean {
  const msg = getErrorRawMessage(err);
  const status = (err as { status?: number; code?: number })?.status ?? (err as { code?: number })?.code;
  return (
    status === 500 ||
    status === 503 ||
    msg.includes('UNAVAILABLE') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ECONNRESET')
  );
}

function extractRetryHintRu(err: unknown): string {
  const msg = getErrorRawMessage(err);
  const retryMatch = msg.match(/Please retry in ([^."\\]+)/i);
  if (!retryMatch) return '';
  const raw = retryMatch[1].trim();
  const h = raw.match(/(\d+)h/);
  const m = raw.match(/(\d+)m/);
  const s = raw.match(/(\d+(?:\.\d+)?)s/);
  const parts: string[] = [];
  if (h) parts.push(`${h[1]} ч`);
  if (m) parts.push(`${m[1]} мин`);
  if (!h && !m && s) parts.push(`${Math.ceil(Number(s[1]))} сек`);
  return parts.length > 0 ? ` Повтор через ~${parts.join(' ')}.` : '';
}

export function toFriendlyAiError(err: unknown): AiServiceError {
  if (err instanceof AiServiceError) return err;

  if (isQuotaError(err)) {
    const waitHint = extractRetryHintRu(err);
    return new AiServiceError(
      429,
      'QUOTA_EXHAUSTED',
      `Дневной лимит бесплатных запросов Gemini API исчерпан.${waitHint} Для увеличения квоты выберите ключ с платным тарифом в панели Settings > Secrets или воспользуйтесь локальной проверкой по словарю.`
    );
  }

  if (isAuthError(err)) {
    return new AiServiceError(
      403,
      'AUTH_ERROR',
      'Ключ Gemini API отклонён или недействителен. Проверьте настройки ключа в панели Settings > Secrets.'
    );
  }

  const msg = getErrorRawMessage(err);
  if (msg.includes('404') || msg.includes('NOT_FOUND')) {
    return new AiServiceError(
      502,
      'MODEL_ERROR',
      'Выбранная модель ИИ временно недоступна. Попробуйте повторить запрос чуть позже.'
    );
  }

  return new AiServiceError(
    502,
    'MODEL_ERROR',
    'Не удалось получить ответ от ИИ-наставника. Попробуйте повторить запрос.'
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function areAllModelsInCooldown(): boolean {
  const now = Date.now();
  return (
    (modelCooldownUntil.get(PRIMARY_MODEL) ?? 0) > now &&
    (modelCooldownUntil.get(FALLBACK_MODEL) ?? 0) > now
  );
}

async function generateWithModelFallback(
  ai: GoogleGenAI,
  buildRequest: (model: string) => GenerateContentParameters
) {
  const now = Date.now();
  const availableModels = [PRIMARY_MODEL, FALLBACK_MODEL].filter(
    (m) => (modelCooldownUntil.get(m) ?? 0) <= now
  );

  if (availableModels.length === 0) {
    const cachedQuotaErr =
      lastQuotaErrorByModel.get(PRIMARY_MODEL) ?? lastQuotaErrorByModel.get(FALLBACK_MODEL);
    if (cachedQuotaErr) {
      throw toFriendlyAiError(cachedQuotaErr);
    }
    throw new AiServiceError(
      429,
      'QUOTA_EXHAUSTED',
      'Дневной лимит бесплатных запросов Gemini API исчерпан. Используется перевод по словарю и локальная проверка.'
    );
  }

  let lastError: unknown = null;
  let quotaError: unknown = null;

  for (const model of availableModels) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await ai.models.generateContent(buildRequest(model));
        modelCooldownUntil.delete(model);
        lastQuotaErrorByModel.delete(model);
        return res;
      } catch (err) {
        lastError = err;
        if (isQuotaError(err)) {
          quotaError = err;
          modelCooldownUntil.set(model, Date.now() + MODEL_COOLDOWN_MS);
          lastQuotaErrorByModel.set(model, err);
          break; // Immediately try fallback model instead of retrying quota errors
        }
        if (isAuthError(err)) {
          throw toFriendlyAiError(err);
        }
        if (isTransientError(err) && attempt === 0) {
          await sleep(700);
          continue;
        }
        break;
      }
    }
  }

  throw toFriendlyAiError(quotaError ?? lastError);
}

export interface EnrichedWordData {
  word: string;
  phonetic: string;
  partOfSpeech: string;
  translation: string;
  exampleEn: string;
  exampleRu: string;
  secondaryExampleEn: string;
  secondaryExampleRu: string;
  cefrLevel: string;
  aiGenerated: boolean;
}

export interface ContextWritingFeedback {
  isCorrect: boolean;
  grammarScore: number;
  naturalnessScore: number;
  usedTargetWordsCorrectly: boolean;
  correctedSentence: string;
  feedbackRu: string;
  grammarNotes: string[];
  improvedVariants: Array<{
    en: string;
    ru: string;
    tone: string;
  }>;
  aiGenerated: boolean;
}

export interface AnalyticsSnapshotForAi {
  userName: string;
  level: number;
  xp: number;
  streakDays: number;
  totalWords: number;
  masteredWords: number;
  learningWords: number;
  dueWords: number;
  reviewsLast14Days: number;
  accuracyPercent: number;
  avgGrammarScore: number;
  hardestWords: Array<{ word: string; translation: string; easeFactor: number }>;
  recentTopics: string[];
}

export interface AiLearningReport {
  title: string;
  summaryRu: string;
  strengths: string[];
  focusAreas: string[];
  actionPlan: string[];
  predictedMilestone: string;
  aiGenerated: boolean;
}

export interface DbWordHint {
  word: string;
  translation: string;
  exampleEn: string;
  exampleRu: string;
  secondaryExampleEn?: string;
  secondaryExampleRu?: string;
  cefrLevel?: string;
}

const HAS_CYRILLIC_RE = /[а-яё]/i;

function isValidRussianText(text: string | undefined, sourceWord: string): boolean {
  if (!text) return false;
  const clean = text.trim();
  if (!clean || clean.toLowerCase() === sourceWord.trim().toLowerCase()) return false;
  return HAS_CYRILLIC_RE.test(clean);
}

async function buildDictionaryEnrichedFallback(
  word: string,
  dict?: DictionaryLookupResult,
  userProvidedTranslation?: string,
  preferredPos?: string
): Promise<EnrichedWordData> {
  const effectivePos = (preferredPos || dict?.partOfSpeech || 'noun').trim();
  const dictExamples = dict?.englishExamples || [];
  const needsTatoeba = dictExamples.length < 2;
  const needsWordTranslation = !isValidRussianText(userProvidedTranslation, word);

  const [translatedWord, tatoebaPairs] = await Promise.all([
    needsWordTranslation
      ? translateEnglishToRussian(word, effectivePos)
      : Promise.resolve(userProvidedTranslation!.trim()),
    needsTatoeba ? lookupTatoebaExamples(word) : Promise.resolve([]),
  ]);

  let exampleEn = dictExamples[0] || '';
  let exampleRu = '';
  if (!exampleEn && tatoebaPairs[0]) {
    exampleEn = tatoebaPairs[0].en;
    exampleRu = tatoebaPairs[0].ru;
  }
  if (!exampleEn) {
    exampleEn = `I often hear "${word}" in everyday English conversations.`;
  }

  let secondaryExampleEn = dictExamples[1] || '';
  let secondaryExampleRu = '';
  const altTatoeba = tatoebaPairs.find((p) => p.en !== exampleEn);
  if (!secondaryExampleEn && altTatoeba) {
    secondaryExampleEn = altTatoeba.en;
    secondaryExampleRu = altTatoeba.ru;
  }
  if (!secondaryExampleEn) {
    secondaryExampleEn = `Try using "${word}" in a short sentence today.`;
  }

  const sentencesToTranslate: string[] = [];
  if (!exampleRu) sentencesToTranslate.push(exampleEn);
  if (!secondaryExampleRu) sentencesToTranslate.push(secondaryExampleEn);

  if (sentencesToTranslate.length > 0) {
    const translatedBatch = await translateSentencesBatchEnToRu(sentencesToTranslate);
    let idx = 0;
    if (!exampleRu) exampleRu = translatedBatch[idx++] || '';
    if (!secondaryExampleRu) secondaryExampleRu = translatedBatch[idx++] || '';
  }

  const finalTranslation =
    (userProvidedTranslation && userProvidedTranslation.trim()) ||
    translatedWord ||
    word;

  return {
    word,
    phonetic: dict?.phonetic || '',
    partOfSpeech: effectivePos,
    translation: finalTranslation,
    exampleEn,
    exampleRu:
      exampleRu ||
      `Постарайтесь естественно использовать слово «${word}» в английской речи.`,
    secondaryExampleEn,
    secondaryExampleRu:
      secondaryExampleRu ||
      `Попробуйте составить короткое предложение со словом «${word}».`,
    cefrLevel: 'B1',
    aiGenerated: false,
  };
}

export async function enrichVocabularyWord(
  rawWord: string,
  dict?: DictionaryLookupResult,
  userProvidedTranslation?: string,
  preferredPos?: string
): Promise<EnrichedWordData> {
  const word = rawWord.trim();
  // Always enrich words via Dictionary API + Tatoeba human examples + queued EN->RU translation (zero Gemini quota burn)
  return buildDictionaryEnrichedFallback(word, dict, userProvidedTranslation, preferredPos);
}

export async function evaluateContextWriting(
  targetWords: string[],
  userSentence: string
): Promise<ContextWritingFeedback> {
  const ai = getGeminiClient();
  if (!ai) {
    throw new AiServiceError(
      503,
      'UNCONFIGURED',
      'GEMINI_API_KEY не настроен. Добавьте ключ в Settings > Secrets для ИИ-проверки грамматики.'
    );
  }

  const response = await generateWithModelFallback(ai, (model) => ({
    model,
    contents: `You are an expert English language tutor helping a Russian-speaking student practice active vocabulary.
Target vocabulary word(s) the student tried to use: ${targetWords.map((w) => `"${w}"`).join(', ')}.
Student's English text:
"""
${userSentence}
"""

Analyze:
1. Grammar, punctuation, prepositions, article usage, and tense consistency.
2. Whether the target word(s) were used accurately in natural English context and collocation.
3. Provide detailed, encouraging feedback in Russian ("feedbackRu").
4. Provide short actionable grammar notes in Russian ("grammarNotes").
5. Provide a polished corrected version ("correctedSentence").
6. Provide 2 natural alternative ways a native speaker (clear everyday A2/B1 English) would express the same idea, each with Russian translation and tone label (e.g. "Вежливый стиль", "Разговорный стиль").`,
    config: {
      ...(model === PRIMARY_MODEL ? { thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM } } : {}),
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          isCorrect: { type: Type.BOOLEAN },
          grammarScore: { type: Type.INTEGER },
          naturalnessScore: { type: Type.INTEGER },
          usedTargetWordsCorrectly: { type: Type.BOOLEAN },
          correctedSentence: { type: Type.STRING },
          feedbackRu: { type: Type.STRING },
          grammarNotes: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          improvedVariants: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                en: { type: Type.STRING },
                ru: { type: Type.STRING },
                tone: { type: Type.STRING },
              },
              required: ['en', 'ru', 'tone'],
            },
          },
        },
        required: [
          'isCorrect',
          'grammarScore',
          'naturalnessScore',
          'usedTargetWordsCorrectly',
          'correctedSentence',
          'feedbackRu',
          'grammarNotes',
          'improvedVariants',
        ],
      },
    },
  }));

  const parsed = JSON.parse((response.text ?? '{}').trim());
  return {
    isCorrect: Boolean(parsed.isCorrect),
    grammarScore: Math.max(0, Math.min(100, Number(parsed.grammarScore ?? 75))),
    naturalnessScore: Math.max(0, Math.min(100, Number(parsed.naturalnessScore ?? 75))),
    usedTargetWordsCorrectly: Boolean(parsed.usedTargetWordsCorrectly),
    correctedSentence: parsed.correctedSentence || userSentence,
    feedbackRu: parsed.feedbackRu || 'Предложение проверено.',
    grammarNotes: Array.isArray(parsed.grammarNotes) ? parsed.grammarNotes : [],
    improvedVariants: Array.isArray(parsed.improvedVariants) ? parsed.improvedVariants : [],
    aiGenerated: true,
  };
}

export async function generateLearningReport(
  snapshot: AnalyticsSnapshotForAi
): Promise<AiLearningReport> {
  const ai = getGeminiClient();
  if (!ai) {
    throw new AiServiceError(
      503,
      'UNCONFIGURED',
      'GEMINI_API_KEY не настроен. Добавьте ключ в Settings > Secrets для генерации ИИ-отчета.'
    );
  }

  const response = await generateWithModelFallback(ai, (model) => ({
    model,
    contents: `Generate a structured, personalized English learning analytics report in Russian for student "${snapshot.userName}".
Real performance telemetry:
- Level: ${snapshot.level}, Total XP: ${snapshot.xp}, Current streak: ${snapshot.streakDays} days
- Total words in vocabulary: ${snapshot.totalWords}
- Mastered words: ${snapshot.masteredWords}, In learning/review: ${snapshot.learningWords}, Currently due: ${snapshot.dueWords}
- Reviews completed in last 14 days: ${snapshot.reviewsLast14Days}
- Recall accuracy: ${snapshot.accuracyPercent}%
- Average AI writing grammar score: ${snapshot.avgGrammarScore}/100
- Hardest words (lowest SM-2 ease factor): ${snapshot.hardestWords.map((h) => `${h.word} (${h.translation})`).join(', ') || 'нет'}
- Active deck topics: ${snapshot.recentTopics.join(', ') || 'Базовая лексика'}

Be specific, reference actual numbers and hardest words, avoid generic fluff, and produce concrete next steps.`,
    config: {
      ...(model === PRIMARY_MODEL ? { thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM } } : {}),
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          summaryRu: { type: Type.STRING },
          strengths: { type: Type.ARRAY, items: { type: Type.STRING } },
          focusAreas: { type: Type.ARRAY, items: { type: Type.STRING } },
          actionPlan: { type: Type.ARRAY, items: { type: Type.STRING } },
          predictedMilestone: { type: Type.STRING },
        },
        required: ['title', 'summaryRu', 'strengths', 'focusAreas', 'actionPlan', 'predictedMilestone'],
      },
    },
  }));

  const parsed = JSON.parse((response.text ?? '{}').trim());
  return {
    title: parsed.title || 'Персональный отчет по прогрессу',
    summaryRu: parsed.summaryRu || '',
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths : [],
    focusAreas: Array.isArray(parsed.focusAreas) ? parsed.focusAreas : [],
    actionPlan: Array.isArray(parsed.actionPlan) ? parsed.actionPlan : [],
    predictedMilestone: parsed.predictedMilestone || '',
    aiGenerated: true,
  };
}

export type TranslationDirection = 'ru_to_en' | 'en_to_ru';

export interface TranslationPromptData {
  direction: TranslationDirection;
  sourceSentence: string;
  targetWords: string[];
  hint: string;
  cefrLevel: string;
  aiGenerated: boolean;
  fallbackNotice?: string;
  referenceTranslation?: string;
}

function buildDictionaryFallbackPrompt(
  targetWords: string[],
  direction: TranslationDirection,
  dbHints: DbWordHint[],
  reasonNotice?: string
): TranslationPromptData {
  const candidates: Array<{
    sourceSentence: string;
    referenceTranslation: string;
    hint: string;
    cefrLevel: string;
  }> = [];

  for (const item of dbHints) {
    if (item.exampleEn && item.exampleRu) {
      candidates.push({
        sourceSentence: direction === 'ru_to_en' ? item.exampleRu : item.exampleEn,
        referenceTranslation: direction === 'ru_to_en' ? item.exampleEn : item.exampleRu,
        hint:
          direction === 'ru_to_en'
            ? `Используйте слово «${item.word}» (${item.translation}).`
            : `Ключевое слово: «${item.word}» — ${item.translation}.`,
        cefrLevel: item.cefrLevel || 'A2–B1',
      });
    }
    if (item.secondaryExampleEn && item.secondaryExampleRu) {
      candidates.push({
        sourceSentence: direction === 'ru_to_en' ? item.secondaryExampleRu : item.secondaryExampleEn,
        referenceTranslation: direction === 'ru_to_en' ? item.secondaryExampleEn : item.secondaryExampleRu,
        hint:
          direction === 'ru_to_en'
            ? `Подойдёт слово «${item.word}» (${item.translation}).`
            : `Обратите внимание на слово «${item.word}» (${item.translation}).`,
        cefrLevel: item.cefrLevel || 'A2–B1',
      });
    }
  }

  if (candidates.length > 0) {
    const picked = candidates[Math.floor(Math.random() * candidates.length)];
    return {
      direction,
      sourceSentence: picked.sourceSentence,
      targetWords,
      hint: picked.hint,
      cefrLevel: picked.cefrLevel,
      aiGenerated: false,
      fallbackNotice: reasonNotice,
      referenceTranslation: picked.referenceTranslation,
    };
  }

  const primaryWord = targetWords[0] || 'practice';
  const primaryHint = dbHints[0]?.translation ? ` (${dbHints[0].translation})` : '';
  return {
    direction,
    sourceSentence:
      direction === 'ru_to_en'
        ? `Я хочу использовать слово «${dbHints[0]?.translation || primaryWord}» в простом предложении на каждый день.`
        : `I often use "${primaryWord}" when I talk about my daily plans.`,
    targetWords,
    hint: `Целевое слово: ${primaryWord}${primaryHint}.`,
    cefrLevel: 'A2–B1',
    aiGenerated: false,
    fallbackNotice: reasonNotice,
    referenceTranslation:
      direction === 'ru_to_en'
        ? `I want to use "${primaryWord}" in a simple everyday sentence.`
        : `Я часто использую «${dbHints[0]?.translation || primaryWord}», когда говорю о планах на день.`,
  };
}

export async function generateTranslationPrompt(
  targetWords: string[],
  direction: TranslationDirection,
  dbHints: DbWordHint[] = []
): Promise<TranslationPromptData> {
  const ai = getGeminiClient();
  if (!ai) {
    return buildDictionaryFallbackPrompt(
      targetWords,
      direction,
      dbHints,
      'Используется задание из вашего словаря (GEMINI_API_KEY не настроен).'
    );
  }

  const directionInstruction =
    direction === 'ru_to_en'
      ? `Generate ONE clear, everyday A2–B1 level Russian sentence (avoid overly complex literary or C1/C2 jargon) that prompts the student to translate it into English using the target English word(s): ${targetWords.map((w) => `"${w}"`).join(', ')}. The Russian sentence must NOT contain English words — express the meaning naturally in Russian so the target English word(s) are the natural translation choice.`
      : `Generate ONE clear, everyday A2–B1 level English sentence (avoid overly complex academic or C1/C2 jargon) that explicitly uses the target English word(s): ${targetWords.map((w) => `"${w}"`).join(', ')}. The student will translate this English sentence into Russian.`;

  try {
    const response = await generateWithModelFallback(ai, (model) => ({
      model,
      contents: `${directionInstruction}
Also provide:
- "hint": a short helpful hint in Russian (for ru_to_en: remind which English word/collocation fits; for en_to_ru: explain a tricky nuance or phrase).
- "cefrLevel": estimated CEFR level (A2 or B1).`,
      config: {
        ...(model === PRIMARY_MODEL ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {}),
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            sourceSentence: { type: Type.STRING },
            hint: { type: Type.STRING },
            cefrLevel: { type: Type.STRING },
          },
          required: ['sourceSentence', 'hint', 'cefrLevel'],
        },
      },
    }));

    const parsed = JSON.parse((response.text ?? '{}').trim());
    return {
      direction,
      sourceSentence: parsed.sourceSentence || '',
      targetWords,
      hint: parsed.hint || '',
      cefrLevel: parsed.cefrLevel || 'B1',
      aiGenerated: true,
    };
  } catch (err) {
    const friendly = toFriendlyAiError(err);
    return buildDictionaryFallbackPrompt(targetWords, direction, dbHints, friendly.message);
  }
}

export async function evaluateTranslationAttempt(
  direction: TranslationDirection,
  sourceSentence: string,
  userTranslation: string,
  targetWords: string[]
): Promise<ContextWritingFeedback> {
  const ai = getGeminiClient();
  if (!ai) {
    throw new AiServiceError(
      503,
      'UNCONFIGURED',
      'GEMINI_API_KEY не настроен. Добавьте ключ в Settings > Secrets для ИИ-проверки перевода.'
    );
  }

  const taskDesc =
    direction === 'ru_to_en'
      ? `Direction: Russian -> English.
Russian source sentence: "${sourceSentence}"
Target English vocabulary word(s) expected: ${targetWords.map((w) => `"${w}"`).join(', ')}.
Student's English translation: "${userTranslation}"`
      : `Direction: English -> Russian.
English source sentence: "${sourceSentence}"
Key English vocabulary word(s) in source: ${targetWords.map((w) => `"${w}"`).join(', ')}.
Student's Russian translation: "${userTranslation}"`;

  const response = await generateWithModelFallback(ai, (model) => ({
    model,
    contents: `You are an expert bilingual English-Russian tutor evaluating a student's translation exercise.
${taskDesc}

Evaluate:
1. Semantic accuracy (did the student convey the exact meaning of the source sentence?).
2. Grammar, spelling, word order, and style in the target language (${direction === 'ru_to_en' ? 'English' : 'Russian'}).
3. Whether the target vocabulary word(s) were translated/used accurately.
4. Provide:
   - "isCorrect": true if meaning and grammar are solid (>= 75 score)
   - "grammarScore": 0-100 overall accuracy & grammar score
   - "naturalnessScore": 0-100 how natural the translation sounds
   - "usedTargetWordsCorrectly": boolean
   - "correctedSentence": the best corrected/polished translation in the target language (${direction === 'ru_to_en' ? 'English' : 'Russian'})
   - "feedbackRu": detailed, constructive feedback in Russian explaining errors, nuances, and word choices
   - "grammarNotes": 1-3 short bullet notes in Russian
   - "improvedVariants": 2 alternative natural translations in the target language, each with "en" (or primary translation), "ru" (explanation/reverse meaning), and "tone" (e.g. "Деловой стиль", "Разговорный вариант").`,
    config: {
      ...(model === PRIMARY_MODEL ? { thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM } } : {}),
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          isCorrect: { type: Type.BOOLEAN },
          grammarScore: { type: Type.INTEGER },
          naturalnessScore: { type: Type.INTEGER },
          usedTargetWordsCorrectly: { type: Type.BOOLEAN },
          correctedSentence: { type: Type.STRING },
          feedbackRu: { type: Type.STRING },
          grammarNotes: { type: Type.ARRAY, items: { type: Type.STRING } },
          improvedVariants: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                en: { type: Type.STRING },
                ru: { type: Type.STRING },
                tone: { type: Type.STRING },
              },
              required: ['en', 'ru', 'tone'],
            },
          },
        },
        required: [
          'isCorrect',
          'grammarScore',
          'naturalnessScore',
          'usedTargetWordsCorrectly',
          'correctedSentence',
          'feedbackRu',
          'grammarNotes',
          'improvedVariants',
        ],
      },
    },
  }));

  const parsed = JSON.parse((response.text ?? '{}').trim());
  return {
    isCorrect: Boolean(parsed.isCorrect),
    grammarScore: Math.max(0, Math.min(100, Number(parsed.grammarScore ?? 75))),
    naturalnessScore: Math.max(0, Math.min(100, Number(parsed.naturalnessScore ?? 75))),
    usedTargetWordsCorrectly: Boolean(parsed.usedTargetWordsCorrectly),
    correctedSentence: parsed.correctedSentence || userTranslation,
    feedbackRu: parsed.feedbackRu || 'Перевод проверен.',
    grammarNotes: Array.isArray(parsed.grammarNotes) ? parsed.grammarNotes : [],
    improvedVariants: Array.isArray(parsed.improvedVariants) ? parsed.improvedVariants : [],
    aiGenerated: true,
  };
}

export function evaluateLocallyWithoutAi(params: {
  mode: 'free' | TranslationDirection;
  userText: string;
  targetWords: string[];
  dbHints: DbWordHint[];
  sourceSentence?: string;
}): ContextWritingFeedback {
  const { mode, userText, targetWords, dbHints, sourceSentence } = params;
  const normalizedInput = userText.trim().toLowerCase();

  const matchingHint = dbHints.find((h) => {
    if (!sourceSentence) return true;
    return (
      h.exampleEn === sourceSentence ||
      h.exampleRu === sourceSentence ||
      h.secondaryExampleEn === sourceSentence ||
      h.secondaryExampleRu === sourceSentence
    );
  }) || dbHints[0];

  const referenceSentence =
    mode === 'ru_to_en'
      ? (matchingHint?.exampleRu === sourceSentence
          ? matchingHint?.exampleEn
          : matchingHint?.secondaryExampleRu === sourceSentence
          ? matchingHint?.secondaryExampleEn
          : matchingHint?.exampleEn) || userText
      : mode === 'en_to_ru'
      ? (matchingHint?.exampleEn === sourceSentence
          ? matchingHint?.exampleRu
          : matchingHint?.secondaryExampleEn === sourceSentence
          ? matchingHint?.secondaryExampleRu
          : matchingHint?.exampleRu) || userText
      : matchingHint?.exampleEn || userText;

  const isEnglishOutput = mode === 'free' || mode === 'ru_to_en';

  const usedTarget = targetWords.some((w) => {
    const stem = w.toLowerCase().trim().slice(0, Math.max(3, w.trim().length - 2));
    if (isEnglishOutput) {
      return normalizedInput.includes(w.toLowerCase()) || normalizedInput.includes(stem);
    }
    const hintForWord = dbHints.find((h) => h.word.toLowerCase() === w.toLowerCase());
    if (!hintForWord) return normalizedInput.length >= 6;
    const ruTokens = hintForWord.translation
      .toLowerCase()
      .split(/[,;/]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3);
    return ruTokens.some((t) => normalizedInput.includes(t.slice(0, Math.max(3, t.length - 2))));
  });

  const endsWithPunctuation = /[.!?]$/.test(userText.trim());
  const startsCapitalized = /^[A-ZА-ЯЁ]/.test(userText.trim());
  const wordCount = userText.trim().split(/\s+/).filter(Boolean).length;

  let score = 60;
  if (usedTarget) score += 20;
  if (wordCount >= 4) score += 10;
  if (endsWithPunctuation) score += 5;
  if (startsCapitalized) score += 5;

  const notes: string[] = [];
  if (!usedTarget) {
    notes.push(
      isEnglishOutput
        ? `Не найдено целевое слово (${targetWords.join(', ')}). Проверьте правописание или форму слова.`
        : `Проверьте, передан ли точный перевод целевого слова (${targetWords.join(', ')}).`
    );
  } else {
    notes.push('Целевое слово использовано в ответе.');
  }
  if (!startsCapitalized || !endsWithPunctuation) {
    notes.push('Начинайте предложение с заглавной буквы и ставьте знак препинания в конце.');
  }
  if (wordCount < 4) {
    notes.push('Старайтесь строить более полное предложение для закрепления контекста.');
  }

  return {
    isCorrect: score >= 75,
    grammarScore: Math.min(95, score),
    naturalnessScore: Math.min(90, score - 5),
    usedTargetWordsCorrectly: usedTarget,
    correctedSentence: referenceSentence,
    feedbackRu:
      'Выполнена базовая локальная проверка по словарю (дневной лимит бесплатных запросов Gemini API временно исчерпан). Сравните свой ответ с эталоном из словаря.',
    grammarNotes: notes,
    improvedVariants: matchingHint?.exampleEn
      ? [
          {
            en: matchingHint.exampleEn,
            ru: matchingHint.exampleRu,
            tone: 'Пример из вашего словаря',
          },
        ]
      : [],
    aiGenerated: false,
  };
}

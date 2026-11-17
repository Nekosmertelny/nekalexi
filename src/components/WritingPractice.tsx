import React, { useEffect, useState } from 'react';
import {
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  Volume2,
  Clock,
  ArrowRightLeft,
  RefreshCw,
  HelpCircle,
} from 'lucide-react';
import { motion } from 'motion/react';
import { ApiError, apiRequest } from '../api/client.ts';
import type { ContextWritingFeedback, WordItem, WritingSubmissionRecord } from '../types/index.ts';
import { speakEnglish } from './FlashcardStudio.tsx';

interface WritingPracticeProps {
  initialWord?: string | null;
  onProgressUpdated: () => void;
}

type PracticeMode = 'free' | 'ru_to_en' | 'en_to_ru';

interface TranslationPromptData {
  direction: 'ru_to_en' | 'en_to_ru';
  sourceSentence: string;
  targetWords: string[];
  hint: string;
  cefrLevel: string;
  aiGenerated?: boolean;
  fallbackNotice?: string;
}

const promptSessionCache = new Map<string, TranslationPromptData>();

export const WritingPractice: React.FC<WritingPracticeProps> = ({
  initialWord,
  onProgressUpdated,
}) => {
  const [mode, setMode] = useState<PracticeMode>('ru_to_en');
  const [words, setWords] = useState<WordItem[]>([]);
  const [selectedWords, setSelectedWords] = useState<string[]>(initialWord ? [initialWord] : []);
  const [sentence, setSentence] = useState('');
  const [checking, setChecking] = useState(false);
  const [generatingPrompt, setGeneratingPrompt] = useState(false);
  const [translationPrompt, setTranslationPrompt] = useState<TranslationPromptData | null>(null);
  const [showHint, setShowHint] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quotaNotice, setQuotaNotice] = useState<string | null>(null);
  const [latestFeedback, setLatestFeedback] = useState<ContextWritingFeedback | null>(null);
  const [history, setHistory] = useState<WritingSubmissionRecord[]>([]);

  useEffect(() => {
    if (initialWord) {
      setSelectedWords((prev) => (prev.includes(initialWord) ? prev : [initialWord, ...prev].slice(0, 3)));
    }
  }, [initialWord]);

  const loadData = async () => {
    const [wordsRes, histRes] = await Promise.all([
      apiRequest<{ words: WordItem[] }>('/api/words'),
      apiRequest<{ history: WritingSubmissionRecord[] }>('/api/practice/history'),
    ]);
    setWords(wordsRes.words);
    setHistory(histRes.history);
    if (!initialWord && wordsRes.words.length > 0) {
      setSelectedWords((prev) => (prev.length === 0 ? [wordsRes.words[0].word] : prev));
    }
  };

  useEffect(() => {
    loadData().catch((err) => {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить словарь для практики');
    });
  }, []);

  const toggleTargetWord = (wordStr: string) => {
    setSelectedWords((prev) => {
      if (prev.includes(wordStr)) {
        return prev.length > 1 ? prev.filter((w) => w !== wordStr) : prev;
      }
      if (prev.length >= 3) {
        return [...prev.slice(1), wordStr];
      }
      return [...prev, wordStr];
    });
  };

  const fetchTranslationTask = async (
    targetDir: 'ru_to_en' | 'en_to_ru',
    wordsForTask: string[],
    forceRefresh = false
  ) => {
    if (wordsForTask.length === 0) return;
    const cacheKey = `${targetDir}:${wordsForTask.slice().sort().join(',')}`;
    if (!forceRefresh) {
      const cached = promptSessionCache.get(cacheKey);
      if (cached) {
        setTranslationPrompt(cached);
        return;
      }
    }

    setGeneratingPrompt(true);
    setError(null);
    setQuotaNotice(null);
    setLatestFeedback(null);
    setSentence('');
    setShowHint(false);
    try {
      const res = await apiRequest<{ prompt: TranslationPromptData }>(
        '/api/practice/translation-prompt',
        {
          method: 'POST',
          body: JSON.stringify({
            targetWords: wordsForTask,
            direction: targetDir,
          }),
        }
      );
      promptSessionCache.set(cacheKey, res.prompt);
      setTranslationPrompt(res.prompt);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сгенерировать предложение');
    } finally {
      setGeneratingPrompt(false);
    }
  };

  // Fetch (or restore from session cache) whenever mode or selected words change
  const selectedKey = selectedWords.slice().sort().join(',');
  useEffect(() => {
    if (mode !== 'free' && selectedWords.length > 0) {
      fetchTranslationTask(mode, selectedWords, false);
    }
  }, [mode, selectedKey]);

  const handleModeChange = (nextMode: PracticeMode) => {
    setMode(nextMode);
    setError(null);
    setQuotaNotice(null);
    setLatestFeedback(null);
    setSentence('');
    setShowHint(false);
  };

  const submitPracticeAnswer = async (useLocalFallback = false) => {
    if (!sentence.trim() || selectedWords.length === 0) return;
    setChecking(true);
    setError(null);
    if (!useLocalFallback) {
      setQuotaNotice(null);
    }
    try {
      if (mode === 'free') {
        const res = await apiRequest<{
          feedback: ContextWritingFeedback;
          xpEarned: number;
        }>('/api/practice/check', {
          method: 'POST',
          body: JSON.stringify({
            targetWords: selectedWords,
            sentence: sentence.trim(),
            localFallback: useLocalFallback,
          }),
        });
        setLatestFeedback(res.feedback);
      } else {
        if (!translationPrompt?.sourceSentence) {
          setError('Сначала сгенерируйте предложение для перевода');
          setChecking(false);
          return;
        }
        const res = await apiRequest<{
          feedback: ContextWritingFeedback;
          xpEarned: number;
        }>('/api/practice/translation-check', {
          method: 'POST',
          body: JSON.stringify({
            direction: mode,
            sourceSentence: translationPrompt.sourceSentence,
            userTranslation: sentence.trim(),
            targetWords: selectedWords,
            localFallback: useLocalFallback,
          }),
        });
        setLatestFeedback(res.feedback);
      }

      onProgressUpdated();
      const histRes = await apiRequest<{ history: WritingSubmissionRecord[] }>('/api/practice/history');
      setHistory(histRes.history);
    } catch (err) {
      const isQuota =
        err instanceof ApiError && (err.status === 429 || err.code === 'QUOTA_EXHAUSTED');
      if (isQuota && !useLocalFallback) {
        const msg =
          err instanceof Error
            ? err.message
            : 'Дневной лимит бесплатных запросов Gemini API исчерпан. Выберите ключ с оплаченным тарифом в Settings > Secrets.';
        setQuotaNotice(`${msg} Выполнена автоматическая локальная проверка по словарю.`);
        await submitPracticeAnswer(true);
        return;
      }
      setError(err instanceof Error ? err.message : 'Не удалось проверить ответ');
    } finally {
      setChecking(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await submitPracticeAnswer(false);
  };

  const selectedWordObjects = words.filter((w) => selectedWords.includes(w.word));

  return (
    <div className="space-y-6">
      {/* Mode Switcher */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
        <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg overflow-x-auto">
          <button
            type="button"
            onClick={() => handleModeChange('ru_to_en')}
            className={`relative px-3 py-1.5 min-h-[36px] text-xs font-medium rounded-md transition-colors whitespace-nowrap flex items-center gap-1.5 ${
              mode === 'ru_to_en'
                ? 'text-slate-900 dark:text-white font-semibold'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            {mode === 'ru_to_en' && (
              <motion.span
                layoutId="writing-mode-pill"
                transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                className="absolute inset-0 rounded-md bg-white dark:bg-slate-900 shadow-sm"
              />
            )}
            <ArrowRightLeft className="relative z-10 w-3.5 h-3.5 text-sky-600" />
            <span className="relative z-10">Перевод RU → EN</span>
          </button>
          <button
            type="button"
            onClick={() => handleModeChange('en_to_ru')}
            className={`relative px-3 py-1.5 min-h-[36px] text-xs font-medium rounded-md transition-colors whitespace-nowrap flex items-center gap-1.5 ${
              mode === 'en_to_ru'
                ? 'text-slate-900 dark:text-white font-semibold'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            {mode === 'en_to_ru' && (
              <motion.span
                layoutId="writing-mode-pill"
                transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                className="absolute inset-0 rounded-md bg-white dark:bg-slate-900 shadow-sm"
              />
            )}
            <ArrowRightLeft className="relative z-10 w-3.5 h-3.5 text-emerald-600" />
            <span className="relative z-10">Перевод EN → RU</span>
          </button>
          <button
            type="button"
            onClick={() => handleModeChange('free')}
            className={`relative px-3 py-1.5 min-h-[36px] text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              mode === 'free'
                ? 'text-slate-900 dark:text-white font-semibold'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            {mode === 'free' && (
              <motion.span
                layoutId="writing-mode-pill"
                transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                className="absolute inset-0 rounded-md bg-white dark:bg-slate-900 shadow-sm"
              />
            )}
            <span className="relative z-10">Свое предложение</span>
          </button>
        </div>

        <span className="text-xs text-slate-500 dark:text-slate-400">
          {mode === 'ru_to_en'
            ? 'Приложение пишет по-русски — вы переводите на английский'
            : mode === 'en_to_ru'
            ? 'Приложение пишет по-английски — вы переводите на русский'
            : 'Составьте собственное английское предложение с новой лексикой'}
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Practice Studio */}
        <div className="lg:col-span-7 space-y-5">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 sm:p-6 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-display text-lg font-bold">
                  {mode === 'ru_to_en'
                    ? 'Переведите предложение на английский'
                    : mode === 'en_to_ru'
                    ? 'Переведите предложение на русский'
                    : 'Практика предложений в контексте'}
                </h2>
                <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-400 mt-1">
                  {mode === 'free'
                    ? 'Выберите от 1 до 3 изучаемых слов и напишите предложение на английском. ИИ проверит грамматику и контекст.'
                    : 'Выберите целевые слова из вашего словаря — ИИ сгенерирует живое предложение для перевода и проверит ваш ответ.'}
                </p>
              </div>
            </div>

            {/* Target Word Selector */}
            <div>
              <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">
                Целевые слова из словаря (выбрано {selectedWords.length}/3):
              </div>
              <div className="flex flex-wrap gap-1.5">
                {words.slice(0, 14).map((w) => {
                  const active = selectedWords.includes(w.word);
                  return (
                    <button
                      key={w.id}
                      type="button"
                      onClick={() => toggleTargetWord(w.word)}
                      className={`min-h-[36px] px-3 py-1 rounded-lg text-xs font-medium border transition-colors ${
                        active
                          ? 'bg-sky-600 border-sky-600 text-white'
                          : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
                      }`}
                    >
                      {w.word}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Translation Prompt Box (in RU->EN or EN->RU modes) */}
            {mode !== 'free' && (
              <div className="p-4 sm:p-5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                    {mode === 'ru_to_en'
                      ? 'Задание на русском языке'
                      : 'Задание на английском языке'}
                    {translationPrompt?.cefrLevel ? ` · Уровень ${translationPrompt.cefrLevel}` : ''}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {mode === 'en_to_ru' && translationPrompt?.sourceSentence && (
                      <button
                        type="button"
                        onClick={() => speakEnglish(translationPrompt.sourceSentence)}
                        title="Озвучить предложение"
                        className="min-h-[34px] px-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs flex items-center gap-1"
                      >
                        <Volume2 className="w-3.5 h-3.5 text-sky-600" />
                        <span>Слушать</span>
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={generatingPrompt || selectedWords.length === 0}
                      onClick={() => fetchTranslationTask(mode, selectedWords, true)}
                      className="min-h-[34px] px-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-medium flex items-center gap-1.5 disabled:opacity-50"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${generatingPrompt ? 'animate-spin' : ''}`} />
                      <span>Новое задание</span>
                    </button>
                  </div>
                </div>

                {generatingPrompt ? (
                  <div className="py-3 text-sm text-slate-500 animate-pulse">
                    Генерация предложения для перевода...
                  </div>
                ) : translationPrompt ? (
                  <>
                    {translationPrompt.fallbackNotice && (
                      <div className="p-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200/80 dark:border-amber-800/70 text-[11px] text-amber-800 dark:text-amber-300 leading-relaxed">
                        {translationPrompt.fallbackNotice} Задание взято из вашего словаря.
                      </div>
                    )}
                    <p className="font-display text-base sm:text-lg font-semibold text-slate-900 dark:text-white leading-snug">
                      {translationPrompt.sourceSentence}
                    </p>
                    {translationPrompt.hint && (
                      <div>
                        <button
                          type="button"
                          onClick={() => setShowHint((h) => !h)}
                          className="text-xs text-sky-600 dark:text-sky-400 hover:underline inline-flex items-center gap-1"
                        >
                          <HelpCircle className="w-3.5 h-3.5" />
                          <span>{showHint ? 'Скрыть подсказку' : 'Показать подсказку'}</span>
                        </button>
                        {showHint && (
                          <p className="text-xs text-slate-600 dark:text-slate-300 mt-1.5">
                            {translationPrompt.hint}
                          </p>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-slate-500">
                    Нажмите «Новое задание», чтобы получить предложение для перевода.
                  </p>
                )}
              </div>
            )}

            {/* Selected Word Context Hints (shown in free mode) */}
            {mode === 'free' && selectedWordObjects.length > 0 && (
              <div className="pt-2 border-t border-slate-100 dark:border-slate-800 space-y-2">
                {selectedWordObjects.map((wo) => (
                  <div key={wo.id} className="text-xs text-slate-600 dark:text-slate-400">
                    <strong className="text-slate-900 dark:text-white">{wo.word}</strong> ({wo.translation}) —{' '}
                    <span className="italic">{wo.example_en}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Answer Input */}
            <form onSubmit={handleSubmit} className="space-y-3">
              <textarea
                rows={3}
                required
                value={sentence}
                onChange={(e) => setSentence(e.target.value)}
                placeholder={
                  mode === 'ru_to_en'
                    ? `Напишите перевод на английском (используйте: ${selectedWords.join(', ')})...`
                    : mode === 'en_to_ru'
                    ? 'Напишите ваш перевод на русском языке...'
                    : `Напишите предложение на английском, используя: ${selectedWords.join(', ')}...`
                }
                className="w-full p-3.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm sm:text-base focus:outline-none focus:ring-2 focus:ring-sky-600"
              />

              {quotaNotice && (
                <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                  {quotaNotice}
                </div>
              )}

              {error && (
                <div className="p-3.5 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300 leading-relaxed">
                  {error}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="submit"
                  disabled={checking || !sentence.trim() || selectedWords.length === 0}
                  className="w-full sm:w-auto min-h-[44px] px-5 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-700 disabled:opacity-60 text-white text-sm font-semibold flex items-center justify-center gap-2 transition-colors"
                >
                  <Sparkles className="w-4 h-4" />
                  <span>
                    {checking
                      ? 'Проверка ответа ИИ...'
                      : mode === 'free'
                      ? 'Проверить предложение'
                      : 'Проверить перевод'}
                  </span>
                </button>

                {mode !== 'free' && latestFeedback && (
                  <button
                    type="button"
                    onClick={() => fetchTranslationTask(mode, selectedWords, true)}
                    className="w-full sm:w-auto min-h-[44px] px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-sm font-medium"
                  >
                    Следующее предложение
                  </button>
                )}
              </div>
            </form>
          </div>

          {/* Latest AI Feedback Result */}
          {latestFeedback && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 sm:p-6 space-y-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-100 dark:border-slate-800">
                <div className="flex items-center gap-2">
                  {latestFeedback.isCorrect ? (
                    <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                  ) : (
                    <AlertTriangle className="w-5 h-5 text-amber-600" />
                  )}
                  <span className="font-display font-bold text-base">
                    {latestFeedback.isCorrect ? 'Отлично выполнено' : 'Есть рекомендации по улучшению'}
                  </span>
                </div>

                <div className="flex items-center gap-4 text-xs tabular-nums">
                  <span>
                    Точность и грамматика:{' '}
                    <strong className="text-slate-900 dark:text-white">{latestFeedback.grammarScore}/100</strong>
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>
                    Естественность:{' '}
                    <strong className="text-slate-900 dark:text-white">{latestFeedback.naturalnessScore}/100</strong>
                  </span>
                </div>
              </div>

              <div>
                <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                  {mode === 'free' ? 'Исправленный вариант:' : 'Эталонный перевод:'}
                </div>
                <div className="flex items-center justify-between gap-3 p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/60">
                  <p className="text-sm sm:text-base font-medium text-slate-900 dark:text-white">
                    {latestFeedback.correctedSentence}
                  </p>
                  {mode !== 'en_to_ru' && (
                    <button
                      type="button"
                      onClick={() => speakEnglish(latestFeedback.correctedSentence)}
                      aria-label="Озвучить перевод"
                      className="min-h-[38px] min-w-[38px] rounded-lg border border-slate-200 dark:border-slate-700 flex items-center justify-center shrink-0 hover:bg-white dark:hover:bg-slate-700"
                    >
                      <Volume2 className="w-4 h-4 text-sky-600" />
                    </button>
                  )}
                </div>
              </div>

              <div>
                <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                  Разбор от ИИ-наставника:
                </div>
                <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
                  {latestFeedback.feedbackRu}
                </p>
              </div>

              {latestFeedback.grammarNotes.length > 0 && (
                <ul className="space-y-1.5 text-xs text-slate-600 dark:text-slate-400 list-disc pl-5">
                  {latestFeedback.grammarNotes.map((note, idx) => (
                    <li key={idx}>{note}</li>
                  ))}
                </ul>
              )}

              {latestFeedback.improvedVariants.length > 0 && (
                <div className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-2.5">
                  <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                    Альтернативные естественные варианты:
                  </div>
                  {latestFeedback.improvedVariants.map((v, idx) => (
                    <div key={idx} className="space-y-0.5">
                      <div className="text-xs font-medium text-sky-600 dark:text-sky-400">{v.tone}</div>
                      <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{v.en}</p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">{v.ru}</p>
                    </div>
                  ))}
                </div>
              )}
            </motion.div>
          )}
        </div>

        {/* Right: Recent Writing & Translation Submissions */}
        <div className="lg:col-span-5">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display font-bold text-base">История практики и переводов</h3>
              <span className="text-xs text-slate-500 tabular-nums">{history.length} записей</span>
            </div>

            {history.length === 0 ? (
              <p className="text-xs text-slate-500 py-6 text-center">
                Пока нет проверенных заданий. Выполните свой первый перевод или напишите предложение слева!
              </p>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {history.map((item) => (
                  <div key={item.id} className="py-3.5 first:pt-0 last:pb-0 space-y-1.5">
                    <div className="flex items-center justify-between gap-2 text-xs text-slate-500 tabular-nums">
                      <span className="font-medium text-sky-600 dark:text-sky-400">
                        {item.target_words}
                      </span>
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {item.grammar_score}/100
                      </span>
                    </div>
                    <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                      {item.user_sentence}
                    </p>
                    {item.corrected_sentence !== item.user_sentence && (
                      <p className="text-xs text-emerald-700 dark:text-emerald-400">
                        Эталон: {item.corrected_sentence}
                      </p>
                    )}
                    <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-2">
                      {item.feedback_ru}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

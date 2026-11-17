import React, { useCallback, useEffect, useState } from 'react';
import { Volume2, RotateCw, CheckCircle2, Sparkles, ArrowRight, Layers, Image as ImageIcon } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { apiRequest } from '../api/client.ts';
import type { Deck, WordItem } from '../types/index.ts';
import { speakEnglish } from '../utils/speech.ts';

export { speakEnglish };

interface FlashcardStudioProps {
  decks: Deck[];
  onProgressUpdated: () => void;
  onGoToWriting: (word: string) => void;
}

export const FlashcardStudio: React.FC<FlashcardStudioProps> = ({
  decks,
  onProgressUpdated,
  onGoToWriting,
}) => {
  const [selectedDeckId, setSelectedDeckId] = useState<number | 'all'>('all');
  const [studyMode, setStudyMode] = useState<'due' | 'all'>('due');
  const [queue, setQueue] = useState<WordItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [sessionReviewed, setSessionReviewed] = useState(0);
  const [sessionXp, setSessionXp] = useState(0);
  const [xpBurst, setXpBurst] = useState<{ id: number; amount: number } | null>(null);
  const [showFrontPhoto, setShowFrontPhoto] = useState(true);
  const [speakingKey, setSpeakingKey] = useState<string | null>(null);
  const [brokenImages, setBrokenImages] = useState<Record<number, boolean>>({});

  const handleSpeak = useCallback(async (key: string, text: string, audioUrl?: string) => {
    setSpeakingKey(key);
    try {
      await speakEnglish(text, audioUrl);
    } finally {
      setSpeakingKey((prev) => (prev === key ? null : prev));
    }
  }, []);

  const loadQueue = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (selectedDeckId !== 'all') params.set('deckId', String(selectedDeckId));
      if (studyMode === 'all') params.set('mode', 'all');
      const data = await apiRequest<{ queue: WordItem[] }>(`/api/study/queue?${params.toString()}`);
      setQueue(data.queue);
      setCurrentIndex(0);
      setFlipped(false);
    } finally {
      setLoading(false);
    }
  }, [selectedDeckId, studyMode]);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  useEffect(() => {
    if (!xpBurst) return;
    const t = setTimeout(() => setXpBurst(null), 1100);
    return () => clearTimeout(t);
  }, [xpBurst]);

  const currentCard = queue[currentIndex] || null;

  const handleRate = useCallback(
    async (quality: 1 | 2 | 3 | 4) => {
      if (!currentCard || submitting) return;
      setSubmitting(true);
      try {
        const res = await apiRequest<{ xpEarned: number }>('/api/study/review', {
          method: 'POST',
          body: JSON.stringify({ wordId: currentCard.id, quality }),
        });
        setSessionReviewed((c) => c + 1);
        setSessionXp((x) => x + res.xpEarned);
        if (res.xpEarned > 0) {
          setXpBurst({ id: Date.now(), amount: res.xpEarned });
        }
        setFlipped(false);
        setCurrentIndex((i) => i + 1);
        onProgressUpdated();
      } finally {
        setSubmitting(false);
      }
    },
    [currentCard, submitting, onProgressUpdated]
  );

  // Keyboard shortcuts: Space to flip, 1-4 to grade
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!currentCard) return;

      if (e.code === 'Space') {
        e.preventDefault();
        setFlipped((f) => !f);
      } else if (flipped && ['Digit1', 'Digit2', 'Digit3', 'Digit4'].includes(e.code)) {
        const q = Number(e.code.replace('Digit', '')) as 1 | 2 | 3 | 4;
        handleRate(q);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [currentCard, flipped, handleRate]);

  const statusLabels: Record<string, string> = {
    new: 'Новое слово',
    learning: 'Изучается',
    review: 'Повторение',
    mastered: 'Выучено',
  };

  return (
    <div className="space-y-6">
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={selectedDeckId}
            onChange={(e) => setSelectedDeckId(e.target.value === 'all' ? 'all' : Number(e.target.value))}
            aria-label="Выбор колоды"
            className="min-h-[42px] px-3.5 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-sky-600 transition-colors"
          >
            <option value="all">Все колоды</option>
            {decks.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title} ({d.word_count})
              </option>
            ))}
          </select>

          <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
            <button
              type="button"
              onClick={() => setStudyMode('due')}
              className={`relative px-3 py-1.5 min-h-[34px] text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                studyMode === 'due'
                  ? 'text-slate-900 dark:text-white'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              {studyMode === 'due' && (
                <motion.span
                  layoutId="study-mode-pill"
                  transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                  className="absolute inset-0 rounded-md bg-white dark:bg-slate-900 shadow-sm"
                />
              )}
              <span className="relative z-10">По расписанию FSRS</span>
            </button>
            <button
              type="button"
              onClick={() => setStudyMode('all')}
              className={`relative px-3 py-1.5 min-h-[34px] text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                studyMode === 'all'
                  ? 'text-slate-900 dark:text-white'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              {studyMode === 'all' && (
                <motion.span
                  layoutId="study-mode-pill"
                  transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                  className="absolute inset-0 rounded-md bg-white dark:bg-slate-900 shadow-sm"
                />
              )}
              <span className="relative z-10">Свободная практика</span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => setShowFrontPhoto((v) => !v)}
            className={`min-h-[38px] px-3 py-1.5 rounded-xl border text-xs font-medium flex items-center gap-1.5 transition-colors ${
              showFrontPhoto
                ? 'border-sky-300 dark:border-sky-800 bg-sky-50/80 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300'
                : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
            }`}
          >
            <ImageIcon className="w-3.5 h-3.5" />
            <span>Фото-ассоциации</span>
          </button>
        </div>

        <div className="relative flex items-center gap-4 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
          <span>
            В очереди: <strong className="text-slate-900 dark:text-white">{Math.max(0, queue.length - currentIndex)}</strong>
          </span>
          <span aria-hidden="true">·</span>
          <span>
            Повторено: <strong className="text-slate-900 dark:text-white">{sessionReviewed}</strong>
          </span>
          <span aria-hidden="true">·</span>
          <span>
            За сессию: <strong className="text-sky-600 dark:text-sky-400">+{sessionXp} XP</strong>
          </span>

          <AnimatePresence>
            {xpBurst && (
              <motion.span
                key={xpBurst.id}
                initial={{ opacity: 0, y: 6, scale: 0.9 }}
                animate={{ opacity: 1, y: -14, scale: 1 }}
                exit={{ opacity: 0, y: -24 }}
                transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
                className="pointer-events-none absolute -top-2 right-0 font-mono text-xs font-bold text-emerald-600 dark:text-emerald-400"
              >
                +{xpBurst.amount} XP
              </motion.span>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Main Flashcard Stage */}
      {loading ? (
        <div className="h-[380px] rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 animate-pulse flex items-center justify-center text-sm text-slate-400">
          Загрузка карточек FSRS...
        </div>
      ) : !currentCard ? (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 sm:p-12 text-center max-w-2xl mx-auto"
        >
          <div className="w-12 h-12 rounded-xl bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 mx-auto mb-4 flex items-center justify-center">
            <CheckCircle2 className="w-6 h-6" />
          </div>
          <h2 className="font-display text-xl font-bold mb-2">
            {studyMode === 'due'
              ? 'Все запланированные карточки повторены!'
              : 'В выбранной колоде пока нет слов'}
          </h2>
          <p className="text-sm text-slate-600 dark:text-slate-400 mb-6">
            {studyMode === 'due'
              ? 'Алгоритм FSRS точно рассчитал стабильность памяти и распределил интервалы следующего повторения. Вы можете открыть свободную практику или закрепить слова в ИИ-письме.'
              : 'Добавьте новые слова или загрузите готовый список в разделе «Словарь».'}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              onClick={() => setStudyMode('all')}
              className="min-h-[44px] px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-sm font-medium transition-colors flex items-center gap-2"
            >
              <Layers className="w-4 h-4" />
              <span>Открыть свободную практику</span>
            </motion.button>
            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              onClick={loadQueue}
              className="min-h-[44px] px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-sm font-medium transition-colors"
            >
              Обновить очередь
            </motion.button>
          </div>
        </motion.div>
      ) : (
        <div className="max-w-3xl mx-auto space-y-5">
          {/* Progress indicator bar */}
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 tabular-nums">
            <span>
              Карточка {currentIndex + 1} из {queue.length}
            </span>
            <span>
              {currentCard.deck_title || 'Личный словарь'} · {statusLabels[currentCard.status]} · {currentCard.cefr_level}
            </span>
          </div>
          <div className="h-1.5 w-full bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden">
            <motion.div
              className="h-full bg-gradient-to-r from-sky-500 to-emerald-500"
              initial={false}
              animate={{ width: `${Math.round(((currentIndex + 1) / queue.length) * 100)}%` }}
              transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            />
          </div>

          {/* 3D Flip Card with Smooth Card-to-Card Entrance */}
          <AnimatePresence mode="wait">
            <motion.div
              key={currentCard.id}
              initial={{ opacity: 0, x: 20, scale: 0.985 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: -20, scale: 0.985 }}
              transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
              className="perspective-1000"
            >
              <div
                onClick={() => setFlipped((f) => !f)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') setFlipped((f) => !f);
                }}
                aria-label="Перевернуть карточку"
                className={`group relative w-full min-h-[360px] sm:min-h-[400px] cursor-pointer transition-transform duration-500 ease-spring-card transform-style-3d ${
                  flipped ? 'rotate-y-180' : 'hover:-translate-y-0.5'
                }`}
              >
                {/* Front Face */}
                <div className="absolute inset-0 backface-hidden rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 sm:p-10 flex flex-col justify-between overflow-hidden shadow-xs">
                  {/* Subtle decorative top hairline & corner brackets */}
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-12 top-0 h-px bg-gradient-to-r from-transparent via-sky-500/40 to-transparent"
                  />
                  <span aria-hidden="true" className="pointer-events-none absolute top-3.5 left-3.5 w-3 h-3 border-t border-l border-sky-500/25 rounded-tl-xs" />
                  <span aria-hidden="true" className="pointer-events-none absolute bottom-3.5 right-3.5 w-3 h-3 border-b border-r border-sky-500/25 rounded-br-xs" />

                  <div className="flex items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                    <span>
                      {currentCard.part_of_speech} · Уровень {currentCard.cefr_level}
                    </span>
                    <motion.button
                      type="button"
                      whileTap={{ scale: 0.94 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSpeak('front-word', currentCard.word, currentCard.audio_url);
                      }}
                      className={`min-h-[40px] min-w-[40px] px-3 rounded-xl border flex items-center gap-1.5 text-xs font-medium transition-colors ${
                        speakingKey === 'front-word'
                          ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/50 text-sky-700 dark:text-sky-300'
                          : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200'
                      }`}
                    >
                      <Volume2 className={`w-4 h-4 text-sky-600 ${speakingKey === 'front-word' ? 'animate-pulse' : ''}`} />
                      <span>{speakingKey === 'front-word' ? 'Звучит...' : 'Озвучить'}</span>
                    </motion.button>
                  </div>

                  <div className="my-auto py-4 flex flex-col sm:flex-row items-center justify-center gap-6">
                    {showFrontPhoto && currentCard.image_url && !brokenImages[currentCard.id] && (
                      <div className="w-36 h-28 sm:w-44 sm:h-32 rounded-2xl overflow-hidden border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 shrink-0 shadow-xs">
                        <img
                          src={currentCard.image_url}
                          alt={currentCard.word}
                          referrerPolicy="no-referrer"
                          onError={() =>
                            setBrokenImages((prev) => ({ ...prev, [currentCard.id]: true }))
                          }
                          className="w-full h-full object-cover"
                        />
                      </div>
                    )}
                    <div className="text-center sm:text-left">
                      <div className="font-display text-3xl sm:text-5xl font-bold tracking-tight text-slate-900 dark:text-white mb-2 break-words">
                        {currentCard.word}
                      </div>
                      {currentCard.phonetic && (
                        <div className="font-mono text-base sm:text-lg text-slate-500 dark:text-slate-400">
                          {currentCard.phonetic}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center justify-center gap-2 text-xs text-slate-400">
                    <RotateCw className="w-3.5 h-3.5 transition-transform duration-300 group-hover:rotate-45" />
                    <span>Нажмите на карточку или пробел, чтобы увидеть перевод и примеры</span>
                  </div>
                </div>

                {/* Back Face */}
                <div className="absolute inset-0 backface-hidden rotate-y-180 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 sm:p-8 flex flex-col justify-between overflow-y-auto shadow-xs">
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-12 top-0 h-px bg-gradient-to-r from-transparent via-emerald-500/40 to-transparent"
                  />

                  <div className="flex items-start justify-between gap-4 pb-4 border-b border-slate-100 dark:border-slate-800">
                    <div className="flex items-center gap-4 min-w-0">
                      {currentCard.image_url && !brokenImages[currentCard.id] && (
                        <div className="hidden sm:block w-20 h-16 rounded-xl overflow-hidden border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 shrink-0">
                          <img
                            src={currentCard.image_url}
                            alt={currentCard.word}
                            referrerPolicy="no-referrer"
                            onError={() =>
                              setBrokenImages((prev) => ({ ...prev, [currentCard.id]: true }))
                            }
                            className="w-full h-full object-cover"
                          />
                        </div>
                      )}
                      <div className="min-w-0">
                        <div className="flex items-center gap-2.5 flex-wrap">
                          <span className="font-display text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white">
                            {currentCard.word}
                          </span>
                          {currentCard.phonetic && (
                            <span className="font-mono text-sm text-slate-500 dark:text-slate-400">
                              {currentCard.phonetic}
                            </span>
                          )}
                        </div>
                        <div className="text-lg sm:text-xl font-semibold text-sky-600 dark:text-sky-400 mt-1">
                          {currentCard.translation}
                        </div>
                      </div>
                    </div>
                    <motion.button
                      type="button"
                      whileTap={{ scale: 0.92 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSpeak('back-word', currentCard.word, currentCard.audio_url);
                      }}
                      aria-label="Произнести слово"
                      className={`min-h-[44px] min-w-[44px] rounded-xl border flex items-center justify-center shrink-0 transition-colors ${
                        speakingKey === 'back-word'
                          ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/50'
                          : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'
                      }`}
                    >
                      <Volume2 className={`w-5 h-5 text-sky-600 ${speakingKey === 'back-word' ? 'animate-pulse' : ''}`} />
                    </motion.button>
                  </div>

                  {/* Bilingual Examples */}
                  <div className="space-y-3.5 my-4">
                    <div>
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                          Пример употребления 1
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSpeak('ex1', currentCard.example_en);
                          }}
                          className="text-xs text-sky-600 hover:underline flex items-center gap-1"
                        >
                          <Volume2 className={`w-3.5 h-3.5 ${speakingKey === 'ex1' ? 'animate-pulse' : ''}`} />
                          <span>{speakingKey === 'ex1' ? 'Звучит...' : 'Слушать'}</span>
                        </button>
                      </div>
                      <p className="text-sm sm:text-base font-medium text-slate-900 dark:text-slate-100">
                        {currentCard.example_en}
                      </p>
                      <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-400 mt-0.5">
                        {currentCard.example_ru}
                      </p>
                    </div>

                    {currentCard.secondary_example_en && (
                      <div className="pt-3 border-t border-slate-100 dark:border-slate-800">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                            Пример употребления 2
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleSpeak('ex2', currentCard.secondary_example_en);
                            }}
                            className="text-xs text-sky-600 hover:underline flex items-center gap-1"
                          >
                            <Volume2 className={`w-3.5 h-3.5 ${speakingKey === 'ex2' ? 'animate-pulse' : ''}`} />
                            <span>{speakingKey === 'ex2' ? 'Звучит...' : 'Слушать'}</span>
                          </button>
                        </div>
                        <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                          {currentCard.secondary_example_en}
                        </p>
                        <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-400 mt-0.5">
                          {currentCard.secondary_example_ru}
                        </p>
                      </div>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-500">
                    <span className="tabular-nums font-mono">
                      FSRS · S: {(currentCard.fsrs_stability ?? 0).toFixed(1)} дн · D: {(currentCard.fsrs_difficulty && currentCard.fsrs_difficulty > 0 ? currentCard.fsrs_difficulty : 5).toFixed(1)}/10 · Повторов: {currentCard.repetitions}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onGoToWriting(currentCard.word);
                      }}
                      className="text-sky-600 hover:text-sky-700 font-medium flex items-center gap-1"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>Составить предложение с ИИ</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            </motion.div>
          </AnimatePresence>

          {/* FSRS Rating Controls */}
          <AnimatePresence mode="wait">
            {!flipped ? (
              <motion.button
                key="reveal-btn"
                type="button"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.16 }}
                whileTap={{ scale: 0.985 }}
                onClick={() => setFlipped(true)}
                className="w-full min-h-[48px] rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold transition-colors shadow-xs"
              >
                Показать перевод и примеры (Пробел)
              </motion.button>
            ) : (
              <motion.div
                key="rating-grid"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18 }}
                className="grid grid-cols-2 sm:grid-cols-4 gap-2.5"
              >
                {(
                  [
                    {
                      q: 1,
                      label: 'Снова',
                      sub: currentCard.intervalPreviews?.[1] || '10 мин',
                      style:
                        'border-red-200 dark:border-red-900/60 bg-red-50/70 dark:bg-red-950/30 text-red-700 dark:text-red-300 hover:bg-red-100/80',
                    },
                    {
                      q: 2,
                      label: 'Трудно',
                      sub: currentCard.intervalPreviews?.[2] || '12 ч',
                      style:
                        'border-amber-200 dark:border-amber-900/60 bg-amber-50/70 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 hover:bg-amber-100/80',
                    },
                    {
                      q: 3,
                      label: 'Хорошо',
                      sub: currentCard.intervalPreviews?.[3] || '1 дн',
                      style:
                        'border-sky-200 dark:border-sky-900/60 bg-sky-50/70 dark:bg-sky-950/30 text-sky-800 dark:text-sky-300 hover:bg-sky-100/80',
                    },
                    {
                      q: 4,
                      label: 'Легко',
                      sub: currentCard.intervalPreviews?.[4] || '4 дн',
                      style:
                        'border-emerald-200 dark:border-emerald-900/60 bg-emerald-50/70 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-300 hover:bg-emerald-100/80',
                    },
                  ] as const
                ).map((btn) => (
                  <motion.button
                    key={btn.q}
                    type="button"
                    disabled={submitting}
                    whileHover={{ y: -2 }}
                    whileTap={{ scale: 0.96 }}
                    onClick={() => handleRate(btn.q)}
                    className={`min-h-[54px] px-3 py-2 rounded-xl border transition-colors flex flex-col items-center justify-center ${btn.style}`}
                  >
                    <span className="text-sm font-semibold">
                      {btn.q}. {btn.label}
                    </span>
                    <span className="text-[11px] font-mono opacity-80 tabular-nums">{btn.sub}</span>
                  </motion.button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
};

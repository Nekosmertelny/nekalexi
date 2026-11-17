import React, { useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, Download, GraduationCap, Sparkles } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { apiRequest, setStoredToken } from '../api/client.ts';
import type { User } from '../types/index.ts';
import { CC0_STUDY_PHOTOS, getPhotoDownloadUrl } from '../data/photos.ts';
import {
  CEFR_DESCRIPTIONS,
  evaluatePlacementTest,
  PLACEMENT_QUESTIONS,
  type CefrLevel,
} from '../data/placementTest.ts';
import { NekaLexiLogo } from './NekaLexiLogo.tsx';
import { SupportFooter } from './SupportFooter.tsx';

interface AuthScreenProps {
  onAuthenticated: (token: string, user: User) => void;
}

const LEVELS_ORDER: CefrLevel[] = ['A1', 'A2', 'B1', 'B2', 'C1'];

export const AuthScreen: React.FC<AuthScreenProps> = ({ onAuthenticated }) => {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [regStep, setRegStep] = useState<'credentials' | 'test' | 'result'>('credentials');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // Placement test state
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [selectedLevel, setSelectedLevel] = useState<CefrLevel>('A2');
  const [testSummary, setTestSummary] = useState<{ correctCount: number; totalQuestions: number } | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imgFailed, setImgFailed] = useState(false);

  const resetRegistrationFlow = () => {
    setRegStep('credentials');
    setQuestionIndex(0);
    setAnswers({});
    setTestSummary(null);
    setSelectedLevel('A2');
    setError(null);
  };

  const completeRegisterRequest = async (levelToSend: CefrLevel) => {
    setError(null);
    setLoading(true);
    try {
      const res = await apiRequest<{ token: string; user: User }>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          password,
          cefrLevel: levelToSend,
        }),
      });
      setStoredToken(res.token);
      onAuthenticated(res.token, res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка регистрации');
    } finally {
      setLoading(false);
    }
  };

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await apiRequest<{ token: string; user: User }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim(), password }),
      });
      setStoredToken(res.token);
      onAuthenticated(res.token, res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка входа');
    } finally {
      setLoading(false);
    }
  };

  const handleContinueToTest = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (name.trim().length < 2) {
      setError('Имя должно содержать минимум 2 символа');
      return;
    }
    if (!email.trim().includes('@')) {
      setError('Введите корректный адрес электронной почты');
      return;
    }
    if (password.length < 6) {
      setError('Пароль должен содержать минимум 6 символов');
      return;
    }
    setQuestionIndex(0);
    setAnswers({});
    setRegStep('test');
  };

  const handleAnswerQuestion = (optionIdx: number) => {
    const q = PLACEMENT_QUESTIONS[questionIndex];
    const nextAnswers = { ...answers, [q.id]: optionIdx };
    setAnswers(nextAnswers);

    if (questionIndex + 1 < PLACEMENT_QUESTIONS.length) {
      setQuestionIndex((i) => i + 1);
    } else {
      const result = evaluatePlacementTest(nextAnswers);
      setSelectedLevel(result.level);
      setTestSummary({
        correctCount: result.correctCount,
        totalQuestions: result.totalQuestions,
      });
      setRegStep('result');
    }
  };

  const currentQ = PLACEMENT_QUESTIONS[questionIndex];

  return (
    <div className="relative min-h-screen bg-[#F8FAFC] dark:bg-[#0B1120] text-[#0F172A] dark:text-slate-100 flex items-center justify-center p-4 sm:p-8 overflow-hidden">
      {/* Subtle Decorative Ambient Background */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-editorial-dots opacity-50 dark:opacity-35" />
        <div className="absolute -top-24 left-1/4 w-[420px] h-[280px] rounded-full bg-sky-400/12 blur-3xl" />
        <div className="absolute -bottom-24 right-1/4 w-[380px] h-[280px] rounded-full bg-emerald-400/10 blur-3xl" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.99 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        className="relative z-10 w-full max-w-5xl grid grid-cols-1 lg:grid-cols-12 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border border-slate-200 dark:border-slate-800 rounded-3xl overflow-hidden shadow-sm"
      >
        {/* Left Auth Form */}
        <div className="lg:col-span-7 p-6 sm:p-10 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between gap-4 mb-7">
              <NekaLexiLogo size="lg" />
              <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-xl">
                <button
                  type="button"
                  onClick={() => {
                    setMode('login');
                    setError(null);
                  }}
                  className={`relative px-3.5 py-1.5 min-h-[36px] text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                    mode === 'login'
                      ? 'text-slate-900 dark:text-white font-semibold'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  {mode === 'login' && (
                    <motion.span
                      layoutId="auth-mode-pill"
                      transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                      className="absolute inset-0 rounded-lg bg-white dark:bg-slate-900 shadow-xs"
                    />
                  )}
                  <span className="relative z-10">Вход</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMode('register');
                    resetRegistrationFlow();
                  }}
                  className={`relative px-3.5 py-1.5 min-h-[36px] text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                    mode === 'register'
                      ? 'text-slate-900 dark:text-white font-semibold'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  {mode === 'register' && (
                    <motion.span
                      layoutId="auth-mode-pill"
                      transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                      className="absolute inset-0 rounded-lg bg-white dark:bg-slate-900 shadow-xs"
                    />
                  )}
                  <span className="relative z-10">Регистрация</span>
                </button>
              </div>
            </div>

            {mode === 'login' ? (
              <>
                <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight mb-2 text-balance">
                  С возвращением в языковую практику
                </h1>
                <p className="text-sm text-slate-600 dark:text-slate-400 mb-6">
                  Интервальное повторение FSRS, реальные фото к словам и ИИ-проверка предложений.
                </p>

                <form onSubmit={handleLoginSubmit} className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Электронная почта
                    </label>
                    <input
                      type="email"
                      required
                      autoComplete="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="user@example.com"
                      className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm focus:outline-none focus:ring-2 focus:ring-sky-600"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Пароль
                    </label>
                    <input
                      type="password"
                      required
                      minLength={6}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Минимум 6 символов"
                      className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm focus:outline-none focus:ring-2 focus:ring-sky-600"
                    />
                  </div>

                  {error && (
                    <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300">
                      {error}
                    </div>
                  )}

                  <motion.button
                    type="submit"
                    disabled={loading}
                    whileTap={{ scale: 0.985 }}
                    className="w-full min-h-[46px] px-5 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-700 disabled:opacity-60 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2"
                  >
                    <span>{loading ? 'Подождите...' : 'Войти в аккаунт'}</span>
                    <ArrowRight className="w-4 h-4" />
                  </motion.button>
                </form>
              </>
            ) : (
              <AnimatePresence mode="wait">
                {regStep === 'credentials' && (
                  <motion.div
                    key="reg-credentials"
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 10 }}
                    transition={{ duration: 0.2 }}
                  >
                    <div className="flex items-center gap-2 text-xs text-sky-600 dark:text-sky-400 font-semibold mb-1.5">
                      <span>Шаг 1 из 2 · Профиль</span>
                    </div>
                    <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight mb-2 text-balance">
                      Создайте профиль для изучения английского
                    </h1>
                    <p className="text-sm text-slate-600 dark:text-slate-400 mb-5">
                      После заполнения данных вы пройдёте короткий тест уровня (A1–C1), чтобы мы сразу подобрали идеальную колоду слов.
                    </p>

                    <form onSubmit={handleContinueToTest} className="space-y-4">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                          Имя
                        </label>
                        <input
                          type="text"
                          required
                          minLength={2}
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          placeholder="Александр Петров"
                          className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm focus:outline-none focus:ring-2 focus:ring-sky-600"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                          Электронная почта
                        </label>
                        <input
                          type="email"
                          required
                          autoComplete="email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          placeholder="user@example.com"
                          className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm focus:outline-none focus:ring-2 focus:ring-sky-600"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                          Пароль
                        </label>
                        <input
                          type="password"
                          required
                          minLength={6}
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          placeholder="Минимум 6 символов"
                          className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm focus:outline-none focus:ring-2 focus:ring-sky-600"
                        />
                      </div>

                      {error && (
                        <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300">
                          {error}
                        </div>
                      )}

                      <motion.button
                        type="submit"
                        whileTap={{ scale: 0.985 }}
                        className="w-full min-h-[46px] px-5 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2"
                      >
                        <GraduationCap className="w-4 h-4" />
                        <span>Пройти тест уровня (1 мин)</span>
                        <ArrowRight className="w-4 h-4" />
                      </motion.button>

                      <button
                        type="button"
                        onClick={() => {
                          if (name.trim().length < 2 || !email.trim().includes('@') || password.length < 6) {
                            setError('Сначала заполните имя, корректный email и пароль (от 6 символов)');
                            return;
                          }
                          setError(null);
                          setTestSummary(null);
                          setRegStep('result');
                        }}
                        className="w-full text-center text-xs text-slate-500 hover:text-sky-600 dark:hover:text-sky-400 py-1 transition-colors"
                      >
                        Я уже знаю свой уровень — выбрать вручную
                      </button>
                    </form>
                  </motion.div>
                )}

                {regStep === 'test' && currentQ && (
                  <motion.div
                    key={`reg-test-${currentQ.id}`}
                    initial={{ opacity: 0, x: 12 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -12 }}
                    transition={{ duration: 0.2 }}
                    className="space-y-4"
                  >
                    <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                      <button
                        type="button"
                        onClick={() =>
                          questionIndex > 0 ? setQuestionIndex((i) => i - 1) : setRegStep('credentials')
                        }
                        className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white"
                      >
                        <ArrowLeft className="w-3.5 h-3.5" />
                        <span>Назад</span>
                      </button>
                      <span className="font-mono tabular-nums font-medium">
                        Вопрос {questionIndex + 1} / {PLACEMENT_QUESTIONS.length} · CEFR {currentQ.level}
                      </span>
                    </div>

                    <div className="h-1.5 w-full bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-sky-500 to-emerald-500 transition-all duration-300"
                        style={{
                          width: `${Math.round(((questionIndex + 1) / PLACEMENT_QUESTIONS.length) * 100)}%`,
                        }}
                      />
                    </div>

                    <div>
                      <p className="text-xs font-medium text-sky-600 dark:text-sky-400 mb-1.5">
                        {currentQ.promptRu}
                      </p>
                      <h2 className="font-display text-lg sm:text-xl font-bold text-slate-900 dark:text-white leading-snug">
                        {currentQ.sentence}
                      </h2>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
                      {currentQ.options.map((opt, idx) => (
                        <motion.button
                          key={opt}
                          type="button"
                          whileTap={{ scale: 0.98 }}
                          onClick={() => handleAnswerQuestion(idx)}
                          className="min-h-[48px] px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 hover:border-sky-500 hover:bg-sky-50/70 dark:hover:bg-sky-950/30 text-left text-sm font-medium transition-colors flex items-center justify-between gap-2"
                        >
                          <span>{opt}</span>
                          <span className="text-xs font-mono text-slate-400">{idx + 1}</span>
                        </motion.button>
                      ))}
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        setTestSummary(null);
                        setRegStep('result');
                      }}
                      className="text-xs text-slate-500 hover:text-sky-600 transition-colors pt-1"
                    >
                      Завершить досрочно и выбрать уровень вручную
                    </button>
                  </motion.div>
                )}

                {regStep === 'result' && (
                  <motion.div
                    key="reg-result"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.22 }}
                    className="space-y-4"
                  >
                    <div className="flex items-center justify-between">
                      <button
                        type="button"
                        onClick={() => setRegStep('credentials')}
                        className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900 dark:hover:text-white"
                      >
                        <ArrowLeft className="w-3.5 h-3.5" />
                        <span>К данным профиля</span>
                      </button>
                      {testSummary && (
                        <span className="text-xs font-mono text-emerald-600 dark:text-emerald-400 font-semibold">
                          Верно: {testSummary.correctCount} из {testSummary.totalQuestions}
                        </span>
                      )}
                    </div>

                    <div className="p-4 rounded-2xl bg-sky-50/80 dark:bg-sky-950/35 border border-sky-200 dark:border-sky-800 space-y-2">
                      <div className="flex items-center gap-2 text-sky-700 dark:text-sky-300 text-xs font-semibold">
                        <CheckCircle2 className="w-4 h-4" />
                        <span>
                          {testSummary ? 'Ваш определённый уровень' : 'Выберите стартовый уровень'}
                        </span>
                      </div>
                      <div className="font-display text-2xl font-bold text-slate-900 dark:text-white">
                        {CEFR_DESCRIPTIONS[selectedLevel].label} · {CEFR_DESCRIPTIONS[selectedLevel].title}
                      </div>
                      <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                        {CEFR_DESCRIPTIONS[selectedLevel].description}
                      </p>
                      <div className="pt-1 flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                        <Sparkles className="w-3.5 h-3.5" />
                        <span>Стартовая колода: «{CEFR_DESCRIPTIONS[selectedLevel].deckNameRu}» (с реальными фото)</span>
                      </div>
                    </div>

                    <div>
                      <div className="text-xs font-medium text-slate-500 mb-2">
                        При желании скорректируйте уровень вручную:
                      </div>
                      <div className="grid grid-cols-5 gap-1.5">
                        {LEVELS_ORDER.map((lvl) => (
                          <button
                            key={lvl}
                            type="button"
                            onClick={() => setSelectedLevel(lvl)}
                            className={`min-h-[40px] rounded-xl border text-xs font-mono font-bold transition-colors ${
                              selectedLevel === lvl
                                ? 'border-sky-600 bg-sky-600 text-white'
                                : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200'
                            }`}
                          >
                            {lvl}
                          </button>
                        ))}
                      </div>
                    </div>

                    {error && (
                      <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300">
                        {error}
                      </div>
                    )}

                    <motion.button
                      type="button"
                      disabled={loading}
                      whileTap={{ scale: 0.985 }}
                      onClick={() => completeRegisterRequest(selectedLevel)}
                      className="w-full min-h-[46px] px-5 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-700 disabled:opacity-60 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2"
                    >
                      <span>{loading ? 'Создаём профиль и колоду...' : `Создать аккаунт (уровень ${selectedLevel})`}</span>
                      <ArrowRight className="w-4 h-4" />
                    </motion.button>
                  </motion.div>
                )}
              </AnimatePresence>
            )}
          </div>

          <SupportFooter compact />
        </div>

        {/* Right Editorial Image Panel (Real CC0 Wikimedia Commons Photograph) */}
        <div className="hidden lg:block lg:col-span-5 relative bg-slate-900">
          {!imgFailed ? (
            <img
              src={CC0_STUDY_PHOTOS[0].previewUrl}
              alt={CC0_STUDY_PHOTOS[0].title}
              referrerPolicy="no-referrer"
              onError={() => setImgFailed(true)}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full bg-gradient-to-br from-slate-800 to-slate-950" />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-slate-950/90 via-slate-950/35 to-transparent flex flex-col justify-end p-8 text-white">
            <div className="text-xs text-slate-300 mb-2">
              FSRS · Реальные фото · Озвучка · A1–C1
            </div>
            <h2 className="font-display text-xl font-bold leading-snug mb-2">
              Учите слова в живом контексте, а не сухими списками
            </h2>
            <p className="text-xs text-slate-300 leading-relaxed mb-4">
              Алгоритм FSRS точно предсказывает забывание, реальные фотографии закрепляют ассоциации, а тест уровня сразу подбирает нужные колоды.
            </p>
            <div className="flex items-center justify-between gap-2 pt-3 border-t border-white/15 text-[11px] text-slate-300">
              <span>Фото: Wikimedia Commons · CC0</span>
              <a
                href={getPhotoDownloadUrl(CC0_STUDY_PHOTOS[0])}
                download={CC0_STUDY_PHOTOS[0].filename}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/15 hover:bg-white/25 text-white font-medium transition-colors"
              >
                <Download className="w-3 h-3" />
                <span>Скачать фото</span>
              </a>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
};

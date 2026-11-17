import React, { useId, useMemo, useState } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  Download,
  ExternalLink,
  Clock,
  Image as ImageIcon,
  Minus,
  Plus,
  Check,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { StudyTimerState } from '../hooks/useStudyTimer.ts';
import { CC0_STUDY_PHOTOS, getPhotoDownloadUrl } from '../data/photos.ts';

interface StudyTimerProps {
  timer: StudyTimerState;
}

const PRESETS = [
  { label: '15 мин', minutes: 15 },
  { label: '25 мин', minutes: 25 },
  { label: '45 мин', minutes: 45 },
  { label: '1 час', minutes: 60 },
  { label: '90 мин', minutes: 90 },
];

const TICK_COUNT = 60;

export const StudyTimer: React.FC<StudyTimerProps> = ({ timer }) => {
  const [selectedPhotoIdx, setSelectedPhotoIdx] = useState(0);
  const [customMinutes, setCustomMinutes] = useState(String(Math.round(timer.durationSeconds / 60)));
  const [imgFailed, setImgFailed] = useState<Record<string, boolean>>({});
  const gradId = useId();
  const glowId = useId();

  const photo = CC0_STUDY_PHOTOS[selectedPhotoIdx] || CC0_STUDY_PHOTOS[0];

  // Chronometer SVG geometry
  const size = 292;
  const center = size / 2;
  const outerTickRadius = 132;
  const ringRadius = 112;
  const strokeWidth = 10;
  const circumference = 2 * Math.PI * ringRadius;
  const dashOffset = circumference * (1 - timer.progress);

  // Smooth orbital tip coordinates
  const angleRad = -Math.PI / 2 + 2 * Math.PI * timer.progress;
  const dotX = center + ringRadius * Math.cos(angleRad);
  const dotY = center + ringRadius * Math.sin(angleRad);

  // Precompute 60 precision dial tick marks
  const dialTicks = useMemo(() => {
    return Array.from({ length: TICK_COUNT }, (_, i) => {
      const isMajor = i % 5 === 0;
      const angle = (-Math.PI / 2) + (i / TICK_COUNT) * Math.PI * 2;
      const innerR = isMajor ? outerTickRadius - 9 : outerTickRadius - 5;
      const outerR = outerTickRadius;
      const x1 = center + innerR * Math.cos(angle);
      const y1 = center + innerR * Math.sin(angle);
      const x2 = center + outerR * Math.cos(angle);
      const y2 = center + outerR * Math.sin(angle);
      return { i, isMajor, x1, y1, x2, y2, frac: i / TICK_COUNT };
    });
  }, [center, outerTickRadius]);

  const totalMinutes = Math.round(timer.durationSeconds / 60);
  const elapsedMinutes = Math.max(
    0,
    Math.floor((timer.durationSeconds * 1000 - timer.remainingMs) / 60000)
  );
  const finishClock = useMemo(() => {
    const finishDate = new Date(Date.now() + timer.remainingMs);
    return finishDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }, [timer.remainingMs]);

  const handleApplyCustom = (e: React.FormEvent) => {
    e.preventDefault();
    const val = Number(customMinutes);
    if (!Number.isNaN(val) && val >= 1 && val <= 180) {
      timer.setDurationMinutes(val);
    }
  };

  const handleAdjustMinutes = (delta: number) => {
    if (timer.isRunning) return;
    const next = Math.max(1, Math.min(180, totalMinutes + delta));
    timer.setDurationMinutes(next);
    setCustomMinutes(String(next));
  };

  const isCompleted = timer.remainingMs <= 0;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
      {/* Left: Precision Circular Chronometer */}
      <div className="lg:col-span-6 relative overflow-hidden bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-[28px] p-6 sm:p-8 flex flex-col items-center justify-between gap-5">
        {/* Subtle decorative hairline glow at top */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-sky-500/45 to-transparent"
        />

        {/* Header */}
        <div className="w-full flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-sky-50 dark:bg-sky-950/60 border border-sky-200/70 dark:border-sky-800/60 text-sky-600 dark:text-sky-400 flex items-center justify-center">
              <Clock className="w-4 h-4" />
            </div>
            <div>
              <h2 className="font-display font-bold text-base sm:text-lg leading-tight">
                Фокус-хронометр
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Плавный отсчет для глубокого запоминания слов
              </p>
            </div>
          </div>

          <span className="text-xs font-medium text-slate-500 dark:text-slate-400 tabular-nums whitespace-nowrap">
            {isCompleted ? 'Завершено' : timer.isRunning ? 'В потоке' : 'Пауза'}
          </span>
        </div>

        {/* Dial Stage */}
        <div className="relative flex items-center justify-center my-1">
          {/* Soft ambient halo behind watch face */}
          <div
            aria-hidden="true"
            className={`pointer-events-none absolute w-56 h-56 rounded-full bg-gradient-to-tr from-sky-400/20 via-cyan-300/15 to-emerald-400/20 dark:from-sky-500/20 dark:via-cyan-400/10 dark:to-emerald-500/15 blur-2xl transition-opacity duration-500 ${
              timer.isRunning ? 'animate-ambient-breath opacity-80' : 'opacity-30'
            }`}
          />

          <svg
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            className="relative z-10 overflow-visible select-none"
            aria-label="Круговой хронометр сессии"
          >
            <defs>
              <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#38BDF8" />
                <stop offset="55%" stopColor="#0284C7" />
                <stop offset="100%" stopColor="#10B981" />
              </linearGradient>
              <filter id={glowId} x="-25%" y="-25%" width="150%" height="150%">
                <feDropShadow dx="0" dy="0" stdDeviation="3.5" floodColor="#0EA5E9" floodOpacity="0.35" />
              </filter>
            </defs>

            {/* Outer delicate bezel ring */}
            <circle
              cx={center}
              cy={center}
              r={outerTickRadius + 8}
              fill="none"
              stroke="currentColor"
              strokeWidth={1}
              className="text-slate-200/80 dark:text-slate-800"
            />

            {/* 60 Precision Radial Tick Marks */}
            {dialTicks.map((tick) => {
              const activeTick = tick.frac <= timer.progress;
              return (
                <line
                  key={tick.i}
                  x1={tick.x1}
                  y1={tick.y1}
                  x2={tick.x2}
                  y2={tick.y2}
                  stroke="currentColor"
                  strokeWidth={tick.isMajor ? 2 : 1.1}
                  strokeLinecap="round"
                  className={
                    activeTick
                      ? tick.isMajor
                        ? 'text-sky-500 dark:text-sky-400 transition-colors duration-300'
                        : 'text-sky-400/55 dark:text-sky-500/45 transition-colors duration-300'
                      : 'text-slate-200 dark:text-slate-800 transition-colors duration-300'
                  }
                />
              );
            })}

            {/* Inner soft recessed face */}
            <circle
              cx={center}
              cy={center}
              r={ringRadius - 14}
              className="fill-slate-50/75 dark:fill-slate-950/65 stroke-slate-200/70 dark:stroke-slate-800/80"
              strokeWidth={1}
            />

            {/* Background circular track */}
            <circle
              cx={center}
              cy={center}
              r={ringRadius}
              fill="none"
              stroke="currentColor"
              strokeWidth={strokeWidth}
              className="text-slate-100 dark:text-slate-800/90"
            />

            {/* Smooth flowing gradient progress arc */}
            <circle
              cx={center}
              cy={center}
              r={ringRadius}
              fill="none"
              stroke={`url(#${gradId})`}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              transform={`rotate(-90 ${center} ${center})`}
              filter={timer.isRunning ? `url(#${glowId})` : undefined}
            />

            {/* Smooth orbiting marker tip */}
            {timer.progress > 0.002 && (
              <g>
                <circle
                  cx={dotX}
                  cy={dotY}
                  r={10}
                  className="fill-sky-500/15 dark:fill-sky-400/20"
                />
                <circle
                  cx={dotX}
                  cy={dotY}
                  r={6.5}
                  className="fill-white dark:fill-slate-950 stroke-sky-600 dark:stroke-sky-400"
                  strokeWidth={3}
                />
              </g>
            )}
          </svg>

          {/* Center Time Readout */}
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center text-center pointer-events-none px-6">
            <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 mb-1 tabular-nums">
              Цель {totalMinutes} мин
            </span>
            <div className="font-mono text-4xl sm:text-[46px] font-bold tracking-tight text-slate-900 dark:text-white tabular-nums leading-none">
              {timer.formattedTime}
            </div>
            <div className="mt-2.5 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
              {isCompleted ? (
                <span className="text-emerald-600 dark:text-emerald-400 font-semibold flex items-center gap-1">
                  <Check className="w-3.5 h-3.5" />
                  Сессия завершена
                </span>
              ) : (
                <span>Осталось {Math.round(timer.progress * 100)}%</span>
              )}
            </div>
          </div>
        </div>

        {/* Main Tactile Controls + Stepper */}
        <div className="w-full space-y-4">
          <div className="flex items-center justify-center gap-2.5">
            <motion.button
              type="button"
              whileTap={{ scale: 0.94 }}
              disabled={timer.isRunning || totalMinutes <= 5}
              onClick={() => handleAdjustMinutes(-5)}
              title="Уменьшить на 5 минут"
              aria-label="Уменьшить на 5 минут"
              className="min-h-[44px] min-w-[44px] rounded-full border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 text-slate-600 dark:text-slate-300 flex items-center justify-center transition-colors"
            >
              <Minus className="w-4 h-4" />
            </motion.button>

            {!timer.isRunning ? (
              <motion.button
                type="button"
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.97 }}
                onClick={timer.start}
                className="min-h-[48px] px-7 py-2.5 rounded-full bg-gradient-to-r from-sky-600 to-sky-500 hover:from-sky-700 hover:to-sky-600 text-white text-sm font-semibold flex items-center gap-2 shadow-sm shadow-sky-600/20 transition-all"
              >
                <Play className="w-4 h-4 fill-current" />
                <span>{isCompleted ? 'Начать заново' : 'Запустить'}</span>
              </motion.button>
            ) : (
              <motion.button
                type="button"
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.97 }}
                onClick={timer.pause}
                className="min-h-[48px] px-7 py-2.5 rounded-full bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold flex items-center gap-2 shadow-sm shadow-amber-600/20 transition-all"
              >
                <Pause className="w-4 h-4 fill-current" />
                <span>Пауза</span>
              </motion.button>
            )}

            <motion.button
              type="button"
              whileTap={{ scale: 0.94 }}
              disabled={timer.isRunning || totalMinutes >= 180}
              onClick={() => handleAdjustMinutes(5)}
              title="Добавить 5 минут"
              aria-label="Добавить 5 минут"
              className="min-h-[44px] min-w-[44px] rounded-full border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 text-slate-600 dark:text-slate-300 flex items-center justify-center transition-colors"
            >
              <Plus className="w-4 h-4" />
            </motion.button>

            <motion.button
              type="button"
              whileTap={{ scale: 0.94 }}
              onClick={timer.reset}
              title="Сбросить таймер"
              aria-label="Сбросить таймер"
              className="min-h-[44px] min-w-[44px] rounded-full border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 flex items-center justify-center transition-colors"
            >
              <RotateCcw className="w-4 h-4" />
            </motion.button>
          </div>

          {/* Sliding Animated Duration Presets */}
          <div className="flex flex-wrap items-center justify-center gap-1 p-1.5 rounded-2xl bg-slate-100/90 dark:bg-slate-800/70 max-w-md mx-auto">
            {PRESETS.map((p) => {
              const active = timer.durationSeconds === p.minutes * 60;
              return (
                <button
                  key={p.minutes}
                  type="button"
                  onClick={() => {
                    timer.setDurationMinutes(p.minutes);
                    setCustomMinutes(String(p.minutes));
                  }}
                  className={`relative min-h-[36px] px-3 py-1.5 rounded-xl text-xs font-medium transition-colors whitespace-nowrap ${
                    active
                      ? 'text-slate-900 dark:text-white font-semibold'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  {active && (
                    <motion.span
                      layoutId="timer-preset-pill"
                      transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                      className="absolute inset-0 rounded-xl bg-white dark:bg-slate-900 shadow-xs"
                    />
                  )}
                  <span className="relative z-10">{p.label}</span>
                </button>
              );
            })}
          </div>

          {/* Custom Minutes Input + Session Summary Strip */}
          <div className="pt-2 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs">
            <form onSubmit={handleApplyCustom} className="flex items-center gap-2">
              <label className="text-slate-500 dark:text-slate-400">Свое время:</label>
              <input
                type="number"
                min={1}
                max={180}
                value={customMinutes}
                onChange={(e) => setCustomMinutes(e.target.value)}
                className="w-16 min-h-[34px] px-2 py-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs text-center font-mono tabular-nums"
              />
              <button
                type="submit"
                className="min-h-[34px] px-3 py-1 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium transition-colors"
              >
                Ок
              </button>
            </form>

            <div className="flex items-center gap-3 text-slate-500 dark:text-slate-400 tabular-nums">
              <span>Прошло: {elapsedMinutes} мин</span>
              <span aria-hidden="true">·</span>
              <span>Финиш в {finishClock}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Right: Real Internet Photographs (CC0 Public Domain) with Smooth Crossfade */}
      <div className="lg:col-span-6 relative overflow-hidden bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-[28px] p-6 sm:p-8 flex flex-col justify-between gap-5">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-emerald-500/40 to-transparent"
        />

        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200/70 dark:border-emerald-800/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
              <ImageIcon className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-display font-bold text-base">Атмосфера для занятий</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Реальные фото CC0 из интернета со свободным скачиванием
              </p>
            </div>
          </div>
        </div>

        {/* Main Animated Photo Frame */}
        <div className="relative aspect-[16/10] w-full rounded-2xl overflow-hidden bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-800">
          <AnimatePresence mode="wait">
            {!imgFailed[photo.id] ? (
              <motion.img
                key={photo.id}
                src={photo.previewUrl}
                alt={photo.title}
                referrerPolicy="no-referrer"
                onError={() => setImgFailed((prev) => ({ ...prev, [photo.id]: true }))}
                initial={{ opacity: 0, scale: 1.04 }}
                animate={{ opacity: 1, scale: timer.isRunning ? 1.05 : 1 }}
                exit={{ opacity: 0, scale: 0.99 }}
                transition={{
                  opacity: { duration: 0.35, ease: [0.16, 1, 0.3, 1] },
                  scale: { duration: timer.isRunning ? 18 : 0.6, ease: 'easeOut' },
                }}
                className="w-full h-full object-cover"
              />
            ) : (
              <motion.div
                key={`fallback-${photo.id}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="w-full h-full flex flex-col items-center justify-center p-6 text-center text-slate-500"
              >
                <ImageIcon className="w-8 h-8 mb-2 opacity-50" />
                <span className="text-xs">{photo.title}</span>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/45 to-transparent p-4 flex flex-col sm:flex-row sm:items-end justify-between gap-3 text-white">
            <AnimatePresence mode="wait">
              <motion.div
                key={`meta-${photo.id}`}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.22 }}
              >
                <div className="text-sm font-semibold">{photo.title}</div>
                <div className="text-[11px] text-slate-200">
                  Лицензия: {photo.license} · Wikimedia Commons
                </div>
              </motion.div>
            </AnimatePresence>

            <div className="flex items-center gap-2 shrink-0">
              <a
                href={getPhotoDownloadUrl(photo)}
                download={photo.filename}
                className="min-h-[38px] px-3.5 py-1.5 rounded-full bg-white text-slate-900 hover:bg-slate-100 text-xs font-semibold flex items-center gap-1.5 transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Скачать</span>
              </a>
              <a
                href={photo.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="Открыть страницу лицензии на Wikimedia Commons"
                className="min-h-[38px] min-w-[38px] rounded-full bg-white/20 hover:bg-white/30 text-white flex items-center justify-center transition-colors"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          </div>
        </div>

        {/* Thumbnails Switcher with Animated Ring */}
        <div className="grid grid-cols-4 gap-2.5">
          {CC0_STUDY_PHOTOS.map((item, idx) => {
            const active = idx === selectedPhotoIdx;
            return (
              <motion.button
                key={item.id}
                type="button"
                whileHover={{ y: -2 }}
                whileTap={{ scale: 0.96 }}
                onClick={() => setSelectedPhotoIdx(idx)}
                className="relative aspect-[4/3] rounded-xl overflow-hidden bg-slate-100 dark:bg-slate-800"
              >
                <img
                  src={item.previewUrl}
                  alt={item.title}
                  referrerPolicy="no-referrer"
                  className={`w-full h-full object-cover transition-opacity duration-200 ${
                    active ? 'opacity-100' : 'opacity-70 hover:opacity-100'
                  }`}
                />
                {active && (
                  <motion.span
                    layoutId="timer-photo-ring"
                    transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                    className="pointer-events-none absolute inset-0 rounded-xl ring-2 ring-inset ring-sky-500"
                  />
                )}
              </motion.button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

import React, { useEffect, useState } from 'react';
import { Trophy, Award, Bell, Flame, Check, GraduationCap } from 'lucide-react';
import { apiRequest } from '../api/client.ts';
import type { AchievementItem, LeaderboardEntry, User } from '../types/index.ts';
import {
  CEFR_DESCRIPTIONS,
  evaluatePlacementTest,
  PLACEMENT_QUESTIONS,
  type CefrLevel,
} from '../data/placementTest.ts';

interface GamificationHubProps {
  user: User;
  onUserUpdated: (user: User) => void;
  onDecksChanged?: () => void;
  refreshSignal: number;
}

export const GamificationHub: React.FC<GamificationHubProps> = ({
  user,
  onUserUpdated,
  onDecksChanged,
  refreshSignal,
}) => {
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [achievements, setAchievements] = useState<AchievementItem[]>([]);
  const [dailyGoal, setDailyGoal] = useState(user.daily_goal || 15);
  const [reminderEnabled, setReminderEnabled] = useState(Boolean(user.reminder_enabled));
  const [reminderTime, setReminderTime] = useState(user.reminder_time || '19:00');
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsSavedMsg, setSettingsSavedMsg] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const [testIdx, setTestIdx] = useState(0);
  const [testAnswers, setTestAnswers] = useState<Record<number, number>>({});
  const [levelUpdating, setLevelUpdating] = useState(false);
  const [levelMsg, setLevelMsg] = useState<string | null>(null);

  useEffect(() => {
    setDailyGoal(user.daily_goal || 15);
    setReminderEnabled(Boolean(user.reminder_enabled));
    setReminderTime(user.reminder_time || '19:00');
  }, [user.daily_goal, user.reminder_enabled, user.reminder_time]);

  const loadData = async () => {
    const [lbRes, achRes] = await Promise.all([
      apiRequest<{ leaderboard: LeaderboardEntry[] }>('/api/gamification/leaderboard'),
      apiRequest<{ achievements: AchievementItem[] }>('/api/gamification/achievements'),
    ]);
    setLeaderboard(lbRes.leaderboard);
    setAchievements(achRes.achievements);
  };

  useEffect(() => {
    loadData().catch(() => {});
  }, [refreshSignal]);

  const handleSaveReminderSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingSettings(true);
    setSettingsSavedMsg(null);
    setSettingsError(null);
    try {
      const res = await apiRequest<{ user: User }>('/api/notifications/settings', {
        method: 'PUT',
        body: JSON.stringify({ dailyGoal, reminderEnabled, reminderTime }),
      });
      onUserUpdated(res.user);
      setSettingsSavedMsg('Настройки ежедневных напоминаний сохранены.');
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : 'Не удалось сохранить настройки');
    } finally {
      setSavingSettings(false);
    }
  };

  const handleTestReminder = async () => {
    setSettingsError(null);
    try {
      await apiRequest('/api/notifications/test-reminder', { method: 'POST' });
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : 'Не удалось отправить тестовое напоминание');
    }
  };

  const handleBrowserNotificationPermission = async () => {
    if ('Notification' in window) {
      const perm = await Notification.requestPermission();
      setSettingsSavedMsg(
        perm === 'granted'
          ? 'Браузерные уведомления разрешены!'
          : 'Разрешение на уведомления браузера отклонено.'
      );
    }
  };

  const applyCefrLevel = async (level: CefrLevel) => {
    setLevelUpdating(true);
    setLevelMsg(null);
    try {
      const res = await apiRequest<{ user: User; addedCount: number }>('/api/auth/level', {
        method: 'PUT',
        body: JSON.stringify({ cefrLevel: level, seedDeck: true }),
      });
      onUserUpdated(res.user);
      onDecksChanged?.();
      setTestOpen(false);
      setLevelMsg(
        res.addedCount > 0
          ? `Уровень обновлён до ${level}. В ваш словарь добавлено слов из подборки: ${res.addedCount}.`
          : `Уровень английского установлен: ${level} (${CEFR_DESCRIPTIONS[level].deckNameRu}).`
      );
    } catch (err) {
      setLevelMsg(err instanceof Error ? err.message : 'Не удалось обновить уровень');
    } finally {
      setLevelUpdating(false);
    }
  };

  const handleTestAnswer = (optIdx: number) => {
    const q = PLACEMENT_QUESTIONS[testIdx];
    const next = { ...testAnswers, [q.id]: optIdx };
    setTestAnswers(next);
    if (testIdx + 1 < PLACEMENT_QUESTIONS.length) {
      setTestIdx((i) => i + 1);
    } else {
      const evaluated = evaluatePlacementTest(next);
      applyCefrLevel(evaluated.level);
    }
  };

  const currentCefr = (['A1', 'A2', 'B1', 'B2', 'C1'].includes(String(user.cefr_level))
    ? user.cefr_level
    : 'A2') as CefrLevel;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      {/* Leaderboard */}
      <div className="lg:col-span-7 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 sm:p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Trophy className="w-5 h-5 text-amber-500" />
            <h2 className="font-display font-bold text-lg">Рейтинг учеников</h2>
          </div>
          <span className="text-xs text-slate-500">Обновляется в реальном времени</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-xs text-slate-500">
                <th className="py-2.5 pr-3 font-medium">#</th>
                <th className="py-2.5 pr-3 font-medium">Участник</th>
                <th className="py-2.5 px-3 font-medium text-right">Уровень</th>
                <th className="py-2.5 px-3 font-medium text-right">Серия</th>
                <th className="py-2.5 px-3 font-medium text-right">Выучено</th>
                <th className="py-2.5 pl-3 font-medium text-right">XP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-sm tabular-nums">
              {leaderboard.map((entry, idx) => {
                const isMe = entry.id === user.id;
                return (
                  <tr
                    key={entry.id}
                    className={
                      isMe
                        ? 'bg-sky-50/70 dark:bg-sky-950/30 font-semibold'
                        : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                    }
                  >
                    <td className="py-3 pr-3 font-mono text-xs text-slate-500">{idx + 1}</td>
                    <td className="py-3 pr-3">
                      <span className="text-slate-900 dark:text-white">{entry.name}</span>
                      {isMe && <span className="text-xs text-sky-600 ml-1.5">(Вы)</span>}
                    </td>
                    <td className="py-3 px-3 text-right font-mono text-xs">Ур. {entry.level}</td>
                    <td className="py-3 px-3 text-right">
                      <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                        <Flame className="w-3.5 h-3.5" />
                        {entry.streak_days}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-right">{entry.mastered_count}</td>
                    <td className="py-3 pl-3 text-right font-mono font-semibold text-sky-600 dark:text-sky-400">
                      {entry.xp}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Daily Reminders + CEFR Level + Achievements */}
      <div className="lg:col-span-5 space-y-6">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 sm:p-6 space-y-3.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <GraduationCap className="w-5 h-5 text-sky-600" />
              <h3 className="font-display font-bold text-base">Уровень английского (CEFR)</h3>
            </div>
            <span className="font-mono text-xs font-bold px-2.5 py-1 rounded-lg bg-sky-50 dark:bg-sky-950/60 text-sky-700 dark:text-sky-300 border border-sky-200 dark:border-sky-800">
              {currentCefr}
            </span>
          </div>

          <p className="text-xs text-slate-600 dark:text-slate-400">
            {CEFR_DESCRIPTIONS[currentCefr].title} — {CEFR_DESCRIPTIONS[currentCefr].description}
          </p>

          {!testOpen ? (
            <div className="space-y-2.5">
              <div className="grid grid-cols-5 gap-1.5">
                {(['A1', 'A2', 'B1', 'B2', 'C1'] as CefrLevel[]).map((lvl) => (
                  <button
                    key={lvl}
                    type="button"
                    disabled={levelUpdating}
                    onClick={() => applyCefrLevel(lvl)}
                    className={`min-h-[36px] rounded-xl border text-xs font-mono font-bold transition-colors ${
                      currentCefr === lvl
                        ? 'border-sky-600 bg-sky-600 text-white'
                        : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'
                    }`}
                  >
                    {lvl}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => {
                  setTestIdx(0);
                  setTestAnswers({});
                  setTestOpen(true);
                }}
                className="w-full min-h-[40px] px-3.5 py-2 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium"
              >
                Пройти тест уровня заново (10 вопросов)
              </button>
            </div>
          ) : (
            <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-3">
              <div className="flex items-center justify-between text-[11px] text-slate-500 font-mono">
                <span>
                  Вопрос {testIdx + 1} / {PLACEMENT_QUESTIONS.length} · {PLACEMENT_QUESTIONS[testIdx].level}
                </span>
                <button
                  type="button"
                  onClick={() => setTestOpen(false)}
                  className="text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
                >
                  Отмена
                </button>
              </div>
              <p className="text-sm font-semibold text-slate-900 dark:text-white">
                {PLACEMENT_QUESTIONS[testIdx].sentence}
              </p>
              <div className="grid grid-cols-2 gap-2">
                {PLACEMENT_QUESTIONS[testIdx].options.map((opt, idx) => (
                  <button
                    key={opt}
                    type="button"
                    disabled={levelUpdating}
                    onClick={() => handleTestAnswer(idx)}
                    className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-sky-500 text-xs font-medium text-left"
                  >
                    {opt}
                  </button>
                ))}
              </div>
            </div>
          )}

          {levelMsg && (
            <div className="text-xs text-emerald-700 dark:text-emerald-400">{levelMsg}</div>
          )}
        </div>

        <form
          onSubmit={handleSaveReminderSettings}
          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 sm:p-6 space-y-4"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Bell className="w-5 h-5 text-sky-600" />
              <h3 className="font-display font-bold text-base">Ежедневные напоминания</h3>
            </div>
            <label className="flex items-center gap-2 text-xs font-medium cursor-pointer">
              <input
                type="checkbox"
                checked={reminderEnabled}
                onChange={(e) => setReminderEnabled(e.target.checked)}
                className="w-4 h-4 accent-sky-600 rounded"
              />
              <span>Включено</span>
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-500 mb-1">Цель слов в день</label>
              <input
                type="number"
                min={5}
                max={200}
                value={dailyGoal}
                onChange={(e) => setDailyGoal(Number(e.target.value))}
                className="w-full min-h-[42px] px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm tabular-nums"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Время напоминания</label>
              <input
                type="time"
                value={reminderTime}
                onChange={(e) => setReminderTime(e.target.value)}
                className="w-full min-h-[42px] px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm font-mono"
              />
            </div>
          </div>

          {settingsSavedMsg && (
            <div className="text-xs text-emerald-700 dark:text-emerald-400">{settingsSavedMsg}</div>
          )}
          {settingsError && (
            <div className="text-xs text-red-600 dark:text-red-400">{settingsError}</div>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={savingSettings}
              className="min-h-[42px] px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-xs font-semibold"
            >
              {savingSettings ? 'Сохранение...' : 'Сохранить'}
            </button>
            <button
              type="button"
              onClick={handleTestReminder}
              className="min-h-[42px] px-3.5 py-2 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium"
            >
              Тест WebSocket-напоминания
            </button>
            <button
              type="button"
              onClick={handleBrowserNotificationPermission}
              className="min-h-[42px] px-3.5 py-2 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium"
            >
              Push в браузере
            </button>
          </div>
        </form>

        {/* Achievements */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 sm:p-6 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Award className="w-5 h-5 text-emerald-600" />
              <h3 className="font-display font-bold text-base">Достижения</h3>
            </div>
            <span className="text-xs text-slate-500 tabular-nums">
              {achievements.filter((a) => a.unlocked_at).length} / {achievements.length}
            </span>
          </div>

          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {achievements.map((ach) => {
              const unlocked = Boolean(ach.unlocked_at);
              return (
                <div
                  key={ach.id}
                  className={`py-3 flex items-start justify-between gap-3 ${
                    unlocked ? '' : 'opacity-55'
                  }`}
                >
                  <div>
                    <div className="flex items-center gap-1.5 text-sm font-semibold">
                      {unlocked && <Check className="w-4 h-4 text-emerald-600 shrink-0" />}
                      <span>{ach.title}</span>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      {ach.description}
                    </p>
                  </div>
                  <span className="font-mono text-xs text-sky-600 dark:text-sky-400 shrink-0 tabular-nums">
                    +{ach.xp_reward} XP
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

import React, { useEffect, useState } from 'react';
import { Sparkles, TrendingUp, Target, BookOpen, BrainCircuit } from 'lucide-react';
import { apiRequest } from '../api/client.ts';
import type { AiReport, AnalyticsOverview } from '../types/index.ts';

export const AnalyticsDashboard: React.FC = () => {
  const [data, setData] = useState<AnalyticsOverview | null>(null);
  const [reports, setReports] = useState<AiReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [hoveredBar, setHoveredBar] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadAnalytics = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [overviewRes, reportsRes] = await Promise.all([
        apiRequest<AnalyticsOverview>('/api/analytics/overview'),
        apiRequest<{ reports: AiReport[] }>('/api/analytics/reports'),
      ]);
      setData(overviewRes);
      setReports(reportsRes.reports);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Не удалось загрузить аналитику');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAnalytics();
  }, []);

  const handleGenerateReport = async () => {
    setGenerating(true);
    setReportError(null);
    try {
      const res = await apiRequest<{ report: AiReport }>('/api/analytics/reports', {
        method: 'POST',
      });
      setReports((prev) => [res.report, ...prev]);
    } catch (err) {
      setReportError(err instanceof Error ? err.message : 'Не удалось сгенерировать отчет');
    } finally {
      setGenerating(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((k) => (
            <div
              key={k}
              className="h-24 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 animate-pulse"
            />
          ))}
        </div>
        <div className="h-72 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 animate-pulse" />
      </div>
    );
  }

  if (loadError || !data) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-8 text-center space-y-3">
        <p className="text-sm text-red-600 dark:text-red-400">
          {loadError || 'Не удалось загрузить статистику обучения.'}
        </p>
        <button
          type="button"
          onClick={loadAnalytics}
          className="min-h-[40px] px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-xs font-semibold"
        >
          Повторить
        </button>
      </div>
    );
  }

  const { summary, velocity14d, heatmap84d, hardestWords } = data;
  const maxReviews = Math.max(5, ...velocity14d.map((d) => d.reviews));
  const totalDist = Math.max(1, summary.totalWords);

  return (
    <div className="space-y-6">
      {/* KPI Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 sm:p-5">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 mb-2">
            <span>Всего слов в словаре</span>
            <BookOpen className="w-4 h-4 text-sky-600" />
          </div>
          <div className="font-display text-2xl sm:text-3xl font-bold tabular-nums">
            {summary.totalWords}
          </div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            К повторению сейчас: {summary.dueWords}
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 sm:p-5">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 mb-2">
            <span>Уверенно выучено</span>
            <Target className="w-4 h-4 text-emerald-600" />
          </div>
          <div className="font-display text-2xl sm:text-3xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
            {summary.masteredWords}
          </div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            {Math.round((summary.masteredWords / totalDist) * 100)}% от всего словаря
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 sm:p-5">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 mb-2">
            <span>Точность запоминания</span>
            <TrendingUp className="w-4 h-4 text-sky-600" />
          </div>
          <div className="font-display text-2xl sm:text-3xl font-bold tabular-nums">
            {summary.accuracyPercent}%
          </div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            Всего повторений: {summary.totalReviews}
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 sm:p-5">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 mb-2">
            <span>Средний балл ИИ-письма</span>
            <BrainCircuit className="w-4 h-4 text-amber-600" />
          </div>
          <div className="font-display text-2xl sm:text-3xl font-bold tabular-nums">
            {summary.avgGrammarScore > 0 ? `${summary.avgGrammarScore}/100` : '—'}
          </div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            Проверок предложений: {summary.writingCount}
          </div>
        </div>
      </div>

      {/* Charts Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* 14-day Velocity Bar Chart */}
        <div className="lg:col-span-7 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 sm:p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h3 className="font-display font-bold text-base">Динамика повторений за 14 дней</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Общее число карточек и успешные ответы (Хорошо / Легко)
              </p>
            </div>
            {hoveredBar !== null && velocity14d[hoveredBar] && (
              <div className="text-xs text-right tabular-nums">
                <span className="font-semibold text-slate-900 dark:text-white">
                  {velocity14d[hoveredBar].label}: {velocity14d[hoveredBar].reviews} карт.
                </span>
                <span className="text-emerald-600 dark:text-emerald-400 ml-2">
                  ({velocity14d[hoveredBar].correct} успешно)
                </span>
              </div>
            )}
          </div>

          <div className="h-52 flex items-end gap-1.5 sm:gap-2.5 pt-4">
            {velocity14d.map((d, idx) => {
              const totalPct = Math.round((d.reviews / maxReviews) * 100);
              const correctPct = d.reviews > 0 ? Math.round((d.correct / d.reviews) * 100) : 0;
              return (
                <div
                  key={d.day}
                  onMouseEnter={() => setHoveredBar(idx)}
                  onMouseLeave={() => setHoveredBar(null)}
                  className="flex-1 flex flex-col items-center h-full justify-end group cursor-pointer"
                >
                  <div className="w-full flex-1 flex items-end justify-center">
                    <div
                      className="w-full max-w-[28px] rounded-t-md bg-slate-200 dark:bg-slate-800 relative overflow-hidden transition-all"
                      style={{ height: `${Math.max(4, totalPct)}%` }}
                    >
                      <div
                        className="absolute bottom-0 left-0 right-0 bg-sky-600 group-hover:bg-sky-500 transition-all"
                        style={{ height: `${correctPct}%` }}
                      />
                    </div>
                  </div>
                  <span className="text-[10px] font-mono text-slate-400 mt-2 tabular-nums">
                    {idx % 2 === 0 ? d.label : ''}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Vocabulary Mastery Breakdown & 12-week Heatmap */}
        <div className="lg:col-span-5 space-y-6">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 sm:p-6 space-y-4">
            <h3 className="font-display font-bold text-base">Распределение слов по этапам FSRS</h3>

            <div className="h-3 w-full rounded-full overflow-hidden flex bg-slate-100 dark:bg-slate-800">
              <div
                className="bg-emerald-500"
                style={{ width: `${(summary.masteredWords / totalDist) * 100}%` }}
              />
              <div
                className="bg-sky-600"
                style={{ width: `${(summary.reviewWords / totalDist) * 100}%` }}
              />
              <div
                className="bg-amber-500"
                style={{ width: `${(summary.learningWords / totalDist) * 100}%` }}
              />
              <div
                className="bg-slate-400"
                style={{ width: `${(summary.newWords / totalDist) * 100}%` }}
              />
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs tabular-nums">
              <div className="flex items-center justify-between">
                <span className="text-slate-600 dark:text-slate-400">Выучено (Mastered)</span>
                <strong className="text-emerald-600 dark:text-emerald-400">{summary.masteredWords}</strong>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-600 dark:text-slate-400">Повторение (Review)</span>
                <strong className="text-sky-600 dark:text-sky-400">{summary.reviewWords}</strong>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-600 dark:text-slate-400">Изучается (Learning)</span>
                <strong className="text-amber-600 dark:text-amber-400">{summary.learningWords}</strong>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-600 dark:text-slate-400">Новые (New)</span>
                <strong className="text-slate-700 dark:text-slate-300">{summary.newWords}</strong>
              </div>
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 sm:p-6 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-display font-bold text-base">Календарь регулярности (12 нед.)</h3>
              <span className="text-xs text-slate-500 tabular-nums">Серия: {summary.streakDays} дн.</span>
            </div>
            <div className="grid grid-cols-12 gap-1.5">
              {heatmap84d.map((cell) => {
                const intensity =
                  cell.count === 0
                    ? 'bg-slate-100 dark:bg-slate-800'
                    : cell.count < 5
                    ? 'bg-sky-200 dark:bg-sky-900'
                    : cell.count < 10
                    ? 'bg-sky-400 dark:bg-sky-700'
                    : 'bg-sky-600 dark:bg-sky-500';
                return (
                  <div
                    key={cell.day}
                    title={`${cell.day}: ${cell.count} повторений`}
                    className={`aspect-square rounded-sm ${intensity}`}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Hardest Words & AI Report Generator */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 sm:p-6">
          <h3 className="font-display font-bold text-base mb-1">Сложные слова для фокуса</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
            Слова с наибольшей сложностью запоминания по алгоритму FSRS
          </p>

          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {hardestWords.length === 0 ? (
              <p className="py-6 text-xs text-slate-500 text-center">
                Слова для анализа появятся после добавления карточек.
              </p>
            ) : (
              hardestWords.map((hw) => {
                const diff =
                  hw.fsrs_difficulty && hw.fsrs_difficulty > 0
                    ? hw.fsrs_difficulty.toFixed(1)
                    : '5.0';
                return (
                  <div key={hw.id} className="py-2.5 flex items-center justify-between gap-3 text-sm">
                    <div>
                      <span className="font-semibold text-slate-900 dark:text-white">{hw.word}</span>
                      <span className="text-slate-500 dark:text-slate-400 text-xs block">
                        {hw.translation}
                      </span>
                    </div>
                    <span className="font-mono text-xs text-amber-600 dark:text-amber-400 tabular-nums shrink-0">
                      D {diff}/10
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="lg:col-span-7 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 sm:p-6 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h3 className="font-display font-bold text-base">ИИ-отчеты о прогрессе обучения</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Автоматический разбор вашей статистики и персональный план на 7 дней от Gemini
              </p>
            </div>
            <button
              type="button"
              disabled={generating}
              onClick={handleGenerateReport}
              className="min-h-[42px] px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-700 disabled:opacity-60 text-white text-xs font-semibold flex items-center justify-center gap-2 whitespace-nowrap shrink-0"
            >
              <Sparkles className="w-4 h-4" />
              <span>{generating ? 'Генерация отчета...' : 'Сгенерировать ИИ-отчет'}</span>
            </button>
          </div>

          {reportError && (
            <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300">
              {reportError}
            </div>
          )}

          {reports.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-500">
              Нажмите «Сгенерировать ИИ-отчет», чтобы получить персональный аналитический разбор на основе ваших повторений и письменных упражнений.
            </div>
          ) : (
            <div className="space-y-4">
              {reports.slice(0, 2).map((rep) => (
                <div
                  key={rep.id}
                  className="pt-4 border-t border-slate-100 dark:border-slate-800 first:border-t-0 first:pt-0 space-y-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="font-display font-bold text-sm sm:text-base">{rep.title}</h4>
                    <span className="text-[11px] font-mono text-slate-400 tabular-nums">
                      {rep.createdAt.slice(0, 10)}
                    </span>
                  </div>
                  <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
                    {rep.summaryRu}
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                    <div>
                      <div className="font-semibold text-emerald-700 dark:text-emerald-400 mb-1">
                        Сильные стороны
                      </div>
                      <ul className="list-disc pl-4 space-y-1 text-slate-600 dark:text-slate-400">
                        {rep.strengths.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <div className="font-semibold text-amber-700 dark:text-amber-400 mb-1">
                        План на 7 дней
                      </div>
                      <ul className="list-disc pl-4 space-y-1 text-slate-600 dark:text-slate-400">
                        {rep.actionPlan.map((a, i) => (
                          <li key={i}>{a}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                  {rep.predictedMilestone && (
                    <div className="text-xs text-sky-700 dark:text-sky-400 font-medium">
                      Прогноз: {rep.predictedMilestone}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

import React, { useEffect, useState } from 'react';
import { Shield, Send, Database, Users, Activity, Trash2 } from 'lucide-react';
import { apiRequest } from '../api/client.ts';
import type { AdminOverviewStats, AdminUserRow } from '../types/index.ts';

interface CuratedWordRow {
  id: number;
  word: string;
  translation: string;
  cefr_level: string;
  status: string;
  owner_name: string;
  deck_title: string | null;
}

export const AdminPanel: React.FC = () => {
  const [stats, setStats] = useState<AdminOverviewStats | null>(null);
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [recentWords, setRecentWords] = useState<CuratedWordRow[]>([]);
  const [broadcastTitle, setBroadcastTitle] = useState('');
  const [broadcastMsg, setBroadcastMsg] = useState('');
  const [broadcastStatus, setBroadcastStatus] = useState<string | null>(null);
  const [deckTitle, setDeckTitle] = useState('');
  const [deckDesc, setDeckDesc] = useState('');
  const [deckCategory, setDeckCategory] = useState('Повседневный английский');
  const [deckCefr, setDeckCefr] = useState('B1');
  const [loading, setLoading] = useState(true);
  const [adminError, setAdminError] = useState<string | null>(null);

  const loadAdminData = async () => {
    setLoading(true);
    setAdminError(null);
    try {
      const [ov, us, ct] = await Promise.all([
        apiRequest<{ stats: AdminOverviewStats }>('/api/admin/overview'),
        apiRequest<{ users: AdminUserRow[] }>('/api/admin/users'),
        apiRequest<{ recentWords: CuratedWordRow[] }>('/api/admin/content'),
      ]);
      setStats(ov.stats);
      setUsers(us.users);
      setRecentWords(ct.recentWords);
    } catch (err) {
      setAdminError(err instanceof Error ? err.message : 'Не удалось загрузить данные панели администратора');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAdminData();
  }, []);

  const handleToggleUserActive = async (u: AdminUserRow) => {
    setAdminError(null);
    try {
      const res = await apiRequest<{ user: AdminUserRow }>(`/api/admin/users/${u.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: u.is_active !== 1 }),
      });
      setUsers((prev) => prev.map((row) => (row.id === u.id ? { ...row, ...res.user } : row)));
    } catch (err) {
      setAdminError(err instanceof Error ? err.message : 'Не удалось изменить статус пользователя');
    }
  };

  const handleToggleUserRole = async (u: AdminUserRow) => {
    setAdminError(null);
    try {
      const nextRole = u.role === 'admin' ? 'user' : 'admin';
      const res = await apiRequest<{ user: AdminUserRow }>(`/api/admin/users/${u.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: nextRole }),
      });
      setUsers((prev) => prev.map((row) => (row.id === u.id ? { ...row, ...res.user } : row)));
    } catch (err) {
      setAdminError(err instanceof Error ? err.message : 'Не удалось изменить роль пользователя');
    }
  };

  const handleDeleteWord = async (wordId: number) => {
    setAdminError(null);
    try {
      await apiRequest(`/api/words/${wordId}`, { method: 'DELETE' });
      setRecentWords((prev) => prev.filter((w) => w.id !== wordId));
    } catch (err) {
      setAdminError(err instanceof Error ? err.message : 'Не удалось удалить слово');
    }
  };

  const handleBroadcast = async (e: React.FormEvent) => {
    e.preventDefault();
    setBroadcastStatus(null);
    setAdminError(null);
    try {
      const res = await apiRequest<{ deliveredOnline: number }>('/api/admin/broadcast', {
        method: 'POST',
        body: JSON.stringify({ title: broadcastTitle, message: broadcastMsg }),
      });
      setBroadcastTitle('');
      setBroadcastMsg('');
      setBroadcastStatus(`Отправлено через WebSocket (онлайн получателей: ${res.deliveredOnline})`);
    } catch (err) {
      setAdminError(err instanceof Error ? err.message : 'Ошибка отправки WebSocket-уведомления');
    }
  };

  const handleCreateCuratedDeck = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdminError(null);
    try {
      await apiRequest('/api/admin/curated-deck', {
        method: 'POST',
        body: JSON.stringify({
          title: deckTitle,
          description: deckDesc,
          category: deckCategory,
          cefrLevel: deckCefr,
        }),
      });
      setDeckTitle('');
      setDeckDesc('');
      setBroadcastStatus('Системная подборка опубликована для всех учеников.');
      loadAdminData();
    } catch (err) {
      setAdminError(err instanceof Error ? err.message : 'Не удалось создать системную подборку');
    }
  };

  if (loading) {
    return <div className="py-12 text-center text-sm text-slate-400">Загрузка панели администратора...</div>;
  }

  if (!stats) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-8 text-center space-y-3">
        <p className="text-sm text-red-600 dark:text-red-400">
          {adminError || 'Ошибка загрузки панели администратора'}
        </p>
        <button
          type="button"
          onClick={loadAdminData}
          className="min-h-[40px] px-4 py-2 rounded-xl bg-sky-600 text-white text-xs font-semibold"
        >
          Повторить
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {adminError && (
        <div className="p-3.5 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300">
          {adminError}
        </div>
      )}
      {/* Platform & DB Performance Metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500 mb-1.5">
            <span>Пользователей</span>
            <Users className="w-4 h-4 text-sky-600" />
          </div>
          <div className="font-display text-2xl font-bold tabular-nums">{stats.totalUsers}</div>
          <div className="text-xs text-slate-500 tabular-nums">Активных: {stats.activeUsers}</div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500 mb-1.5">
            <span>Слов и повторений</span>
            <Activity className="w-4 h-4 text-emerald-600" />
          </div>
          <div className="font-display text-2xl font-bold tabular-nums">{stats.totalWords}</div>
          <div className="text-xs text-slate-500 tabular-nums">Повторений: {stats.totalReviews}</div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500 mb-1.5">
            <span>Отклик БД (SQLite WAL)</span>
            <Database className="w-4 h-4 text-sky-600" />
          </div>
          <div className="font-display text-2xl font-bold font-mono tabular-nums">
            {stats.queryLatencyMs} ms
          </div>
          <div className="text-xs text-slate-500 tabular-nums">Колод: {stats.totalDecks}</div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500 mb-1.5">
            <span>WebSocket онлайн</span>
            <Shield className="w-4 h-4 text-amber-600" />
          </div>
          <div className="font-display text-2xl font-bold tabular-nums">{stats.onlineWsClients}</div>
          <div className="text-xs text-slate-500 tabular-nums">ИИ-проверок: {stats.totalWritings}</div>
        </div>
      </div>

      {/* Broadcast & Curated Deck */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <form
          onSubmit={handleBroadcast}
          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-3"
        >
          <h3 className="font-display font-bold text-base">
            Мгновенное WebSocket-уведомление всем
          </h3>
          <input
            type="text"
            required
            value={broadcastTitle}
            onChange={(e) => setBroadcastTitle(e.target.value)}
            placeholder="Заголовок объявления"
            className="w-full min-h-[42px] px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm"
          />
          <textarea
            rows={2}
            required
            value={broadcastMsg}
            onChange={(e) => setBroadcastMsg(e.target.value)}
            placeholder="Текст системного сообщения для всех онлайн-пользователей..."
            className="w-full p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm"
          />
          {broadcastStatus && (
            <div className="text-xs text-emerald-700 dark:text-emerald-400">{broadcastStatus}</div>
          )}
          <button
            type="submit"
            className="min-h-[42px] px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-xs font-semibold flex items-center gap-2"
          >
            <Send className="w-3.5 h-3.5" />
            <span>Отправить через WebSocket</span>
          </button>
        </form>

        <form
          onSubmit={handleCreateCuratedDeck}
          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-3"
        >
          <h3 className="font-display font-bold text-base">Опубликовать системную колоду</h3>
          <input
            type="text"
            required
            value={deckTitle}
            onChange={(e) => setDeckTitle(e.target.value)}
            placeholder="Название подборки"
            className="w-full min-h-[42px] px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm"
          />
          <div className="grid grid-cols-2 gap-2.5">
            <input
              type="text"
              value={deckCategory}
              onChange={(e) => setDeckCategory(e.target.value)}
              placeholder="Категория"
              className="min-h-[42px] px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm"
            />
            <select
              value={deckCefr}
              onChange={(e) => setDeckCefr(e.target.value)}
              className="min-h-[42px] px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm"
            >
              <option value="A2">A2</option>
              <option value="B1">B1</option>
              <option value="B2">B2</option>
              <option value="C1">C1</option>
              <option value="C2">C2</option>
            </select>
          </div>
          <input
            type="text"
            value={deckDesc}
            onChange={(e) => setDeckDesc(e.target.value)}
            placeholder="Краткое описание"
            className="w-full min-h-[42px] px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm"
          />
          <button
            type="submit"
            className="min-h-[42px] px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-semibold"
          >
            Создать системную подборку
          </button>
        </form>
      </div>

      {/* Users Management Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 sm:p-6">
        <h3 className="font-display font-bold text-base mb-4">Управление пользователями</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-xs text-slate-500">
                <th className="py-2.5 pr-3 font-medium">Пользователь</th>
                <th className="py-2.5 px-3 font-medium">Роль</th>
                <th className="py-2.5 px-3 font-medium text-right">Слов</th>
                <th className="py-2.5 px-3 font-medium text-right">XP</th>
                <th className="py-2.5 px-3 font-medium">Статус</th>
                <th className="py-2.5 pl-3 font-medium text-right">Действия</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-xs sm:text-sm tabular-nums">
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="py-3 pr-3">
                    <div className="font-medium text-slate-900 dark:text-white">{u.name}</div>
                    <div className="text-xs text-slate-500">{u.email}</div>
                  </td>
                  <td className="py-3 px-3 font-mono text-xs">{u.role}</td>
                  <td className="py-3 px-3 text-right">{u.words_count}</td>
                  <td className="py-3 px-3 text-right font-mono">{u.xp}</td>
                  <td className="py-3 px-3">
                    <span className={u.is_active ? 'text-emerald-600' : 'text-red-600'}>
                      {u.is_active ? 'Активен' : 'Заблокирован'}
                    </span>
                  </td>
                  <td className="py-3 pl-3 text-right space-x-2 whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => handleToggleUserRole(u)}
                      className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs"
                    >
                      Сменить роль
                    </button>
                    <button
                      type="button"
                      onClick={() => handleToggleUserActive(u)}
                      className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs"
                    >
                      {u.is_active ? 'Блок' : 'Разблок'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Content Moderation */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 sm:p-6">
        <h3 className="font-display font-bold text-base mb-4">Модерация словарного контента</h3>
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {recentWords.slice(0, 15).map((w) => (
            <div key={w.id} className="py-2.5 flex items-center justify-between gap-4 text-sm">
              <div>
                <span className="font-semibold">{w.word}</span> —{' '}
                <span className="text-slate-600 dark:text-slate-400">{w.translation}</span>
                <div className="text-xs text-slate-400">
                  Владелец: {w.owner_name} · {w.deck_title || 'Без колоды'} · {w.cefr_level}
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleDeleteWord(w.id)}
                title="Удалить слово"
                className="min-h-[36px] min-w-[36px] rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-red-50 hover:text-red-600 flex items-center justify-center"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

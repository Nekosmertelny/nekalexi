import React, { useCallback, useEffect, useState } from 'react';
import {
  BookOpen,
  Layers,
  PenTool,
  BarChart3,
  Trophy,
  Shield,
  Bell,
  LogOut,
  Sun,
  Moon,
  Flame,
  Wifi,
  WifiOff,
  X,
  Clock,
} from 'lucide-react';
import { AnimatePresence, motion, MotionConfig } from 'motion/react';
import { apiRequest, getStoredToken, setStoredToken } from './api/client.ts';
import { useWebSocketNotifications, type WsIncomingEvent } from './hooks/useWebSocket.ts';
import { useStudyTimer } from './hooks/useStudyTimer.ts';
import type { AppNotification, Deck, User } from './types/index.ts';
import { AuthScreen } from './components/AuthScreen.tsx';
import { FlashcardStudio } from './components/FlashcardStudio.tsx';
import { VocabularyManager } from './components/VocabularyManager.tsx';
import { WritingPractice } from './components/WritingPractice.tsx';
import { AnalyticsDashboard } from './components/AnalyticsDashboard.tsx';
import { GamificationHub } from './components/GamificationHub.tsx';
import { AdminPanel } from './components/AdminPanel.tsx';
import { NotificationsDrawer } from './components/NotificationsDrawer.tsx';
import { StudyTimer } from './components/StudyTimer.tsx';
import { NekaLexiLogo } from './components/NekaLexiLogo.tsx';
import { SupportFooter } from './components/SupportFooter.tsx';

type NavTab = 'study' | 'vocabulary' | 'writing' | 'timer' | 'analytics' | 'gamification' | 'admin';

export default function App() {
  const [token, setToken] = useState<string | null>(() => getStoredToken());
  const [user, setUser] = useState<User | null>(null);
  const [todayReviews, setTodayReviews] = useState(0);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [activeTab, setActiveTab] = useState<NavTab>('study');
  const [decks, setDecks] = useState<Deck[]>([]);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [notifOpen, setNotifOpen] = useState(false);
  const [toast, setToast] = useState<{ title: string; message: string } | null>(null);
  const [practiceWord, setPracticeWord] = useState<string | null>(null);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const timer = useStudyTimer(60, () => {
    setToast({
      title: 'Сессия таймера завершена',
      message: 'Отличная работа! Вы завершили запланированный фокус-блок.',
    });
  });
  const [darkMode, setDarkMode] = useState(() => {
    try {
      return localStorage.getItem('lexiforge_theme') === 'dark';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
      localStorage.setItem('lexiforge_theme', 'dark');
    } else {
      root.classList.remove('dark');
      localStorage.setItem('lexiforge_theme', 'light');
    }
  }, [darkMode]);

  const loadSessionData = useCallback(async () => {
    if (!token) {
      setBootstrapping(false);
      return;
    }
    try {
      const [meRes, decksRes, notifRes] = await Promise.all([
        apiRequest<{ user: User; todayReviews: number }>('/api/auth/me'),
        apiRequest<{ decks: Deck[] }>('/api/decks'),
        apiRequest<{ notifications: AppNotification[] }>('/api/notifications'),
      ]);
      setUser(meRes.user);
      setTodayReviews(meRes.todayReviews);
      setDecks(decksRes.decks);
      setNotifications(notifRes.notifications);
    } catch {
      setStoredToken(null);
      setToken(null);
      setUser(null);
    } finally {
      setBootstrapping(false);
    }
  }, [token]);

  useEffect(() => {
    loadSessionData();
  }, [loadSessionData]);

  const handleWsEvent = useCallback((ev: WsIncomingEvent) => {
    if (
      ev.type === 'achievement:unlocked' ||
      ev.type === 'reminder:due' ||
      ev.type === 'admin:broadcast' ||
      ev.type === 'notification:new'
    ) {
      const p = ev.payload as { id?: number; title?: string; message?: string; type?: AppNotification['type'] };
      const title = String(p.title || 'Уведомление');
      const message = String(p.message || '');
      setToast({ title, message });

      // Trigger browser notification if permitted
      if ('Notification' in window && Notification.permission === 'granted') {
        try {
          new Notification(title, { body: message });
        } catch {
          // Ignore browser restriction
        }
      }

      setNotifications((prev) => {
        if (p.id && prev.some((n) => n.id === p.id)) return prev;
        return [
          {
            id: p.id || Date.now(),
            user_id: null,
            type: p.type || (ev.type === 'achievement:unlocked' ? 'achievement' : ev.type === 'admin:broadcast' ? 'system' : 'reminder'),
            title,
            message,
            is_read: 0,
            created_at: ev.timestamp,
          },
          ...prev,
        ];
      });
    }
    if (ev.type === 'leaderboard:updated' || ev.type === 'achievement:unlocked') {
      setRefreshSignal((s) => s + 1);
    }
  }, []);

  const { connected: wsConnected } = useWebSocketNotifications(token, handleWsEvent);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5500);
    return () => clearTimeout(t);
  }, [toast]);

  const handleAuthenticated = (newToken: string, authedUser: User) => {
    setToken(newToken);
    setUser(authedUser);
  };

  const handleLogout = async () => {
    await apiRequest('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setStoredToken(null);
    setToken(null);
    setUser(null);
  };

  const refreshDecksAndMe = useCallback(async () => {
    try {
      const [meRes, decksRes] = await Promise.all([
        apiRequest<{ user: User; todayReviews: number }>('/api/auth/me'),
        apiRequest<{ decks: Deck[] }>('/api/decks'),
      ]);
      setUser(meRes.user);
      setTodayReviews(meRes.todayReviews);
      setDecks(decksRes.decks);
      setRefreshSignal((s) => s + 1);
    } catch {
      // Ignore background refresh error
    }
  }, []);

  const handleMarkRead = async (id: number) => {
    await apiRequest(`/api/notifications/${id}/read`, { method: 'POST' }).catch(() => {});
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, is_read: 1 } : n)));
  };

  const handleMarkAllRead = async () => {
    await apiRequest('/api/notifications/read-all', { method: 'POST' }).catch(() => {});
    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: 1 })));
  };

  if (bootstrapping) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F8FAFC] dark:bg-[#0B1120] text-sm text-slate-500">
        Загрузка nekaLexi...
      </div>
    );
  }

  if (!user || !token) {
    return (
      <MotionConfig reducedMotion="user">
        <AuthScreen onAuthenticated={handleAuthenticated} />
      </MotionConfig>
    );
  }

  const unreadCount = notifications.filter((n) => !n.is_read).length;

  const navItems: Array<{ id: NavTab; label: string; shortLabel: string; icon: React.ReactNode }> = [
    { id: 'study', label: 'Карточки FSRS', shortLabel: 'Карточки', icon: <BookOpen className="w-4 h-4" /> },
    { id: 'vocabulary', label: 'Словарь и списки', shortLabel: 'Словарь', icon: <Layers className="w-4 h-4" /> },
    { id: 'writing', label: 'ИИ-практика письма', shortLabel: 'Письмо', icon: <PenTool className="w-4 h-4" /> },
    { id: 'timer', label: 'Таймер и фокус', shortLabel: 'Таймер', icon: <Clock className="w-4 h-4" /> },
    { id: 'analytics', label: 'Аналитика и отчеты', shortLabel: 'Аналитика', icon: <BarChart3 className="w-4 h-4" /> },
    { id: 'gamification', label: 'Рейтинг и цели', shortLabel: 'Рейтинг', icon: <Trophy className="w-4 h-4" /> },
    ...(user.role === 'admin'
      ? [{ id: 'admin' as NavTab, label: 'Админ-панель', shortLabel: 'Админ', icon: <Shield className="w-4 h-4" /> }]
      : []),
  ];

  const currentTabTitle = navItems.find((i) => i.id === activeTab)?.label || 'nekaLexi';

  return (
    <MotionConfig reducedMotion="user">
      <div className="relative min-h-screen bg-[#F8FAFC] dark:bg-[#0B1120] text-[#0F172A] dark:text-slate-100 flex overflow-x-hidden">
        {/* Subtle Decorative Atmospheric Wash + Dot Grid */}
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
        >
          <div className="absolute inset-0 bg-editorial-dots opacity-45 dark:opacity-35" />
          <div className="absolute -top-32 right-[10%] w-[520px] h-[320px] rounded-full bg-sky-400/10 dark:bg-sky-500/10 blur-3xl" />
          <div className="absolute top-[38%] -left-24 w-[380px] h-[280px] rounded-full bg-emerald-400/8 dark:bg-emerald-500/8 blur-3xl" />
        </div>

        {/* Desktop Sidebar */}
        <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:fixed lg:inset-y-0 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border-r border-slate-200 dark:border-slate-800 z-30">
          <div className="h-14 px-5 flex items-center border-b border-slate-200 dark:border-slate-800">
            <NekaLexiLogo size="md" />
          </div>

          <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
            {navItems.map((item) => {
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`relative w-full min-h-[42px] px-3.5 py-2 rounded-xl text-sm font-medium flex items-center gap-3 transition-colors whitespace-nowrap ${
                    active
                      ? 'text-sky-700 dark:text-sky-300 font-semibold'
                      : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50/90 dark:hover:bg-slate-800/60 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  {active && (
                    <motion.span
                      layoutId="sidebar-active-indicator"
                      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                      className="absolute inset-0 rounded-xl bg-sky-50 dark:bg-sky-950/60 border border-sky-200/70 dark:border-sky-800/50"
                    />
                  )}
                  <span className="relative z-10 shrink-0">{item.icon}</span>
                  <span className="relative z-10">{item.label}</span>
                </button>
              );
            })}
          </nav>

        {/* User Progress Summary in Sidebar */}
        <div className="p-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-900 dark:text-white truncate">{user.name}</span>
              <span className="font-mono text-sky-600 dark:text-sky-400 tabular-nums">
                {user.cefr_level || 'A2'} · Ур. {user.level}
              </span>
            </div>
            <div className="flex items-center justify-between text-xs text-slate-500 tabular-nums">
              <span>Цель дня: {todayReviews}/{user.daily_goal}</span>
              <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                <Flame className="w-3.5 h-3.5" />
                {user.streak_days} дн.
              </span>
            </div>
            <div className="h-1.5 w-full bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-sky-600 transition-all"
                style={{
                  width: `${Math.min(100, Math.round((todayReviews / Math.max(1, user.daily_goal)) * 100))}%`,
                }}
              />
            </div>
          </div>

          <button
            type="button"
            onClick={handleLogout}
            className="w-full min-h-[38px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium text-slate-600 dark:text-slate-300 flex items-center justify-center gap-2"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Выйти</span>
          </button>
        </div>
      </aside>

      {/* Main Content Shell */}
      <div className="relative z-10 flex-1 lg:pl-64 flex flex-col min-w-0 pb-20 lg:pb-0">
        {/* Sticky Top Header (52px mobile / 56px desktop) */}
        <header className="sticky top-0 z-20 h-[52px] lg:h-14 bg-white/90 dark:bg-slate-900/90 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 px-4 sm:px-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="lg:hidden shrink-0">
              <NekaLexiLogo size="sm" />
            </div>
            <span className="lg:hidden text-slate-300 dark:text-slate-700">/</span>
            <h1 className="font-display text-sm sm:text-base font-bold truncate">
              {currentTabTitle}
            </h1>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setActiveTab('timer')}
              title="Открыть таймер сессии"
              className={`min-h-[38px] px-3 py-1.5 rounded-full border text-xs font-mono tabular-nums flex items-center gap-1.5 transition-colors ${
                timer.isRunning
                  ? 'border-sky-500/40 bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300'
                  : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300'
              }`}
            >
              <Clock className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" />
              <span>{timer.formattedTime}</span>
            </button>

            <span
              title={wsConnected ? 'WebSocket подключен' : 'WebSocket переподключается'}
              className="hidden sm:inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 mr-1"
            >
              {wsConnected ? (
                <Wifi className="w-3.5 h-3.5 text-emerald-600" />
              ) : (
                <WifiOff className="w-3.5 h-3.5 text-slate-400" />
              )}
              <span className="tabular-nums font-mono">{user.xp} XP</span>
            </span>

            <button
              type="button"
              onClick={() => setDarkMode((d) => !d)}
              aria-label="Переключить тему"
              className="min-h-[40px] min-w-[40px] rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center justify-center"
            >
              {darkMode ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-slate-600" />}
            </button>

            <button
              type="button"
              onClick={() => setNotifOpen(true)}
              aria-label="Уведомления"
              className="relative min-h-[40px] min-w-[40px] rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center justify-center"
            >
              <Bell className="w-4 h-4" />
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-sky-600 text-white text-[10px] font-mono font-bold flex items-center justify-center">
                  {unreadCount}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={handleLogout}
              aria-label="Выйти"
              className="lg:hidden min-h-[40px] min-w-[40px] rounded-xl border border-slate-200 dark:border-slate-700 flex items-center justify-center"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Main Viewport with Smooth Tab Transitions */}
        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-6xl w-full mx-auto">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            >
              {activeTab === 'study' && (
                <FlashcardStudio
                  decks={decks}
                  onProgressUpdated={refreshDecksAndMe}
                  onGoToWriting={(w) => {
                    setPracticeWord(w);
                    setActiveTab('writing');
                  }}
                />
              )}

              {activeTab === 'vocabulary' && (
                <VocabularyManager
                  decks={decks}
                  userCefrLevel={user.cefr_level}
                  onRefreshDecks={refreshDecksAndMe}
                  onPracticeWord={(w) => {
                    setPracticeWord(w);
                    setActiveTab('writing');
                  }}
                />
              )}

              {activeTab === 'writing' && (
                <WritingPractice
                  initialWord={practiceWord}
                  onProgressUpdated={refreshDecksAndMe}
                />
              )}

              {activeTab === 'timer' && <StudyTimer timer={timer} />}

              {activeTab === 'analytics' && <AnalyticsDashboard />}

              {activeTab === 'gamification' && (
                <GamificationHub
                  user={user}
                  onUserUpdated={setUser}
                  onDecksChanged={refreshDecksAndMe}
                  refreshSignal={refreshSignal}
                />
              )}

              {activeTab === 'admin' && user.role === 'admin' && <AdminPanel />}
            </motion.div>
          </AnimatePresence>

          <SupportFooter />
        </main>
      </div>

      {/* Mobile Fixed Bottom Thumb Navigation (<= 15% viewport height cap) */}
      <nav
        aria-label="Мобильная навигация"
        className="lg:hidden fixed bottom-0 left-0 right-0 z-30 h-16 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border-t border-slate-200 dark:border-slate-800 px-1 flex items-center gap-0.5 overflow-x-auto"
      >
        {navItems.map((item) => {
          const active = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveTab(item.id)}
              className={`relative min-h-[44px] min-w-[60px] flex-1 shrink-0 px-1 flex flex-col items-center justify-center gap-1 rounded-lg transition-colors ${
                active ? 'text-sky-600 dark:text-sky-400 font-semibold' : 'text-slate-500 dark:text-slate-400'
              }`}
            >
              {active && (
                <motion.span
                  layoutId="mobile-active-indicator"
                  transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                  className="absolute top-0.5 inset-x-3 h-0.5 rounded-full bg-sky-600 dark:bg-sky-400"
                />
              )}
              {item.icon}
              <span className="text-[10px] tracking-tight whitespace-nowrap">{item.shortLabel}</span>
            </button>
          );
        })}
      </nav>

      {/* Real-Time WebSocket Toast */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 18, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 380, damping: 28 }}
            className="fixed bottom-20 lg:bottom-6 right-4 left-4 sm:left-auto sm:w-96 z-50 bg-slate-900 dark:bg-white text-white dark:text-slate-900 rounded-2xl p-4 shadow-xl border border-slate-700 dark:border-slate-200 flex items-start justify-between gap-3"
          >
            <div className="space-y-0.5">
              <div className="text-xs font-semibold text-sky-400 dark:text-sky-600">
                {toast.title}
              </div>
              <p className="text-xs opacity-90 leading-relaxed">{toast.message}</p>
            </div>
            <button
              type="button"
              onClick={() => setToast(null)}
              aria-label="Закрыть уведомление"
              className="p-1 rounded-lg hover:bg-white/10 dark:hover:bg-slate-100"
            >
              <X className="w-4 h-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <NotificationsDrawer
        open={notifOpen}
        onClose={() => setNotifOpen(false)}
        notifications={notifications}
        onMarkRead={handleMarkRead}
        onMarkAllRead={handleMarkAllRead}
      />
    </div>
    </MotionConfig>
  );
}

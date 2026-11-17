import React from 'react';
import { X, Bell, Award, Megaphone, CheckCheck } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { AppNotification } from '../types/index.ts';

interface NotificationsDrawerProps {
  open: boolean;
  onClose: () => void;
  notifications: AppNotification[];
  onMarkRead: (id: number) => void;
  onMarkAllRead: () => void;
}

export const NotificationsDrawer: React.FC<NotificationsDrawerProps> = ({
  open,
  onClose,
  notifications,
  onMarkRead,
  onMarkAllRead,
}) => {
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 bg-black/40 backdrop-blur-xs"
            onClick={onClose}
            aria-hidden="true"
          />
          <motion.aside
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 360, damping: 34 }}
            className="relative w-full max-w-md bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 h-full flex flex-col z-10 shadow-2xl"
          >
            <div className="p-4 sm:p-5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div>
                <h2 className="font-display font-bold text-base">Центр уведомлений</h2>
                <p className="text-xs text-slate-500">WebSocket-события и напоминания</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onMarkAllRead}
                  className="min-h-[36px] px-2.5 rounded-lg text-xs font-medium text-sky-600 hover:bg-sky-50 dark:hover:bg-sky-950/40 flex items-center gap-1 transition-colors"
                >
                  <CheckCheck className="w-3.5 h-3.5" />
                  <span>Прочитать все</span>
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Закрыть уведомления"
                  className="min-h-[40px] min-w-[40px] rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
              {notifications.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-500">
                  Новых уведомлений пока нет.
                </div>
              ) : (
                notifications.map((n, index) => (
                  <motion.div
                    key={n.id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.18, delay: Math.min(index * 0.03, 0.25) }}
                    onClick={() => onMarkRead(n.id)}
                    className={`p-4 cursor-pointer transition-colors ${
                      n.is_read
                        ? 'opacity-65 hover:bg-slate-50 dark:hover:bg-slate-800/30'
                        : 'bg-sky-50/40 dark:bg-sky-950/20 hover:bg-sky-50/70'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 shrink-0">
                        {n.type === 'achievement' ? (
                          <Award className="w-4 h-4 text-emerald-600" />
                        ) : n.type === 'system' ? (
                          <Megaphone className="w-4 h-4 text-amber-600" />
                        ) : (
                          <Bell className="w-4 h-4 text-sky-600" />
                        )}
                      </div>
                      <div className="flex-1 space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-slate-900 dark:text-white">
                            {n.title}
                          </span>
                          {!n.is_read && (
                            <span className="text-[11px] font-medium text-sky-600 shrink-0">Новое</span>
                          )}
                        </div>
                        <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                          {n.message}
                        </p>
                        <div className="text-[11px] font-mono text-slate-400">
                          {n.created_at.slice(0, 16).replace('T', ' ')}
                        </div>
                      </div>
                    </div>
                  </motion.div>
                ))
              )}
            </div>
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  );
};

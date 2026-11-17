import React from 'react';
import { Mail, Send } from 'lucide-react';

interface SupportFooterProps {
  compact?: boolean;
}

export const SupportFooter: React.FC<SupportFooterProps> = ({ compact = false }) => {
  return (
    <footer
      className={`border-t border-slate-200/80 dark:border-slate-800/80 text-xs text-slate-500 dark:text-slate-400 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 ${
        compact ? 'pt-4 mt-6' : 'pt-5 mt-10 pb-2'
      }`}
    >
      <span className="whitespace-nowrap">
        © {new Date().getFullYear()} nekaLexi · Английская практика A2–B1
      </span>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <span className="text-slate-400 dark:text-slate-500">Поддержка:</span>
        <a
          href="mailto:nekajon.nekka@gmail.com"
          className="inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-300 hover:text-sky-600 dark:hover:text-sky-400 transition-colors"
        >
          <Mail className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400 shrink-0" />
          <span>nekajon.nekka@gmail.com</span>
        </a>
        <a
          href="https://t.me/zxcneka"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-300 hover:text-sky-600 dark:hover:text-sky-400 transition-colors whitespace-nowrap"
        >
          <Send className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400 shrink-0" />
          <span>Telegram @zxcneka</span>
        </a>
      </div>
    </footer>
  );
};

import React, { useId } from 'react';

interface NekaLexiLogoProps {
  size?: 'sm' | 'md' | 'lg';
  showWordmark?: boolean;
  className?: string;
}

const SIZE_MAP = {
  sm: { box: 'w-7 h-7', text: 'text-base', gap: 'gap-2' },
  md: { box: 'w-8 h-8', text: 'text-lg', gap: 'gap-2.5' },
  lg: { box: 'w-10 h-10', text: 'text-xl', gap: 'gap-3' },
};

export const NekaLexiLogo: React.FC<NekaLexiLogoProps> = ({
  size = 'md',
  showWordmark = true,
  className = '',
}) => {
  const gradId = useId();
  const s = SIZE_MAP[size];

  return (
    <div className={`group inline-flex items-center ${s.gap} ${className}`}>
      <svg
        viewBox="0 0 40 40"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={`${s.box} shrink-0 drop-shadow-xs transition-transform duration-300 ease-spring-card group-hover:-rotate-3 group-hover:scale-105`}
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={gradId} x1="2" y1="2" x2="38" y2="38" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#0EA5E9" />
            <stop offset="55%" stopColor="#0284C7" />
            <stop offset="100%" stopColor="#0369A1" />
          </linearGradient>
        </defs>
        <rect x="2" y="2" width="36" height="36" rx="10" fill={`url(#${gradId})`} />
        <rect
          x="13"
          y="8"
          width="18"
          height="22"
          rx="3.5"
          transform="rotate(10 22 19)"
          fill="#FFFFFF"
          fillOpacity="0.30"
        />
        <rect x="9" y="10" width="19" height="22" rx="3.5" fill="#FFFFFF" />
        <path
          d="M13.8 25.5V16.5L23.2 25.5V16.5"
          stroke="#0284C7"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M30.5 6L31.45 8.55L34 9.5L31.45 10.45L30.5 13L29.55 10.45L27 9.5L29.55 8.55L30.5 6Z"
          fill="#34D399"
        />
      </svg>

      {showWordmark && (
        <span className={`font-display ${s.text} font-extrabold tracking-tight whitespace-nowrap`}>
          <span className="text-slate-900 dark:text-white">neka</span>
          <span className="text-sky-600 dark:text-sky-400">Lexi</span>
        </span>
      )}
    </div>
  );
};

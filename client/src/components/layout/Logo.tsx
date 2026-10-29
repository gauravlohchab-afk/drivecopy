import { useId } from 'react';

export function Logo({ className = '' }: { className?: string }) {
  // Unique per instance: a gradient defined inside a hidden copy of the logo would not render.
  const gid = useId();
  return (
    <span className={`flex items-center gap-2.5 ${className}`}>
      <svg viewBox="0 0 32 32" className="size-8" aria-hidden>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#7c6cf6" />
            <stop offset="1" stopColor="#4b3ec9" />
          </linearGradient>
        </defs>
        <rect width="32" height="32" rx="9" fill={`url(#${gid})`} />
        <path d="M10 21.5h12.2a4.3 4.3 0 0 0 .6-8.56A6 6 0 0 0 11.3 14a3.75 3.75 0 0 0-1.3 7.5Z" fill="#fff" />
        <path d="M12.6 18.2h7.6" stroke="#6f5cf2" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <span className="text-lg font-semibold tracking-tight text-slate-900">Cirrus</span>
    </span>
  );
}

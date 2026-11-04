export function Logo({ className = '', tone = 'dark' }: { className?: string; tone?: 'dark' | 'light' }) {
  return (
    <span className={`flex items-center gap-2.5 ${className}`}>
      <svg viewBox="0 0 32 32" className="size-8" aria-hidden>
        <rect width="32" height="32" rx="7" fill={tone === 'light' ? '#fff' : 'var(--color-accent)'} />
        <path d="M10 21.5h12.2a4.3 4.3 0 0 0 .6-8.56A6 6 0 0 0 11.3 14a3.75 3.75 0 0 0-1.3 7.5Z" fill={tone === 'light' ? 'var(--color-accent)' : '#fff'} />
      </svg>
      <span className={`text-lg font-semibold ${tone === 'light' ? 'text-white' : 'text-ink-strong'}`}>Ageless Datahub</span>
    </span>
  );
}

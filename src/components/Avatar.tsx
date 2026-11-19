import { useState } from 'react';

interface AvatarProps {
  src: string | null;
  name: string;
  sizeClass?: string;
  isBot?: boolean;
}

export function Avatar({ src, name, sizeClass = 'h-9 w-9', isBot = false }: AvatarProps) {
  const [failed, setFailed] = useState(false);

  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

  if (src && !failed) {
    return (
      <img
        src={src}
        alt={name}
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={`${sizeClass} shrink-0 rounded-full object-cover border border-slate-200 bg-slate-100`}
      />
    );
  }

  return (
    <div
      aria-label={name}
      className={`${sizeClass} shrink-0 rounded-full flex items-center justify-center text-xs font-semibold border ${
        isBot
          ? 'bg-blue-700 text-white border-blue-800'
          : 'bg-slate-100 text-slate-700 border-slate-200'
      }`}
    >
      {initials || 'U'}
    </div>
  );
}

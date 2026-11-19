import type { ReactNode } from 'react';

function renderInline(line: string, keyPrefix: string): ReactNode[] {
  const tokens: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let idx = 0;

  while ((match = pattern.exec(line)) !== null) {
    if (match.index > lastIndex) {
      tokens.push(line.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('**') && token.endsWith('**')) {
      tokens.push(
        <strong key={`${keyPrefix}-b-${idx}`} className="font-semibold text-slate-900">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith('*') && token.endsWith('*')) {
      tokens.push(
        <em key={`${keyPrefix}-i-${idx}`} className="italic text-slate-700">
          {token.slice(1, -1)}
        </em>
      );
    } else if (token.startsWith('`') && token.endsWith('`')) {
      tokens.push(
        <code
          key={`${keyPrefix}-c-${idx}`}
          className="font-mono text-xs bg-slate-100 text-slate-800 px-1 py-0.5 rounded"
        >
          {token.slice(1, -1)}
        </code>
      );
    }
    lastIndex = pattern.lastIndex;
    idx += 1;
  }

  if (lastIndex < line.length) {
    tokens.push(line.slice(lastIndex));
  }
  return tokens;
}

export function FormattedText({ text }: { text: string }) {
  const lines = text.split('\n');

  return (
    <div className="space-y-1.5 text-sm leading-relaxed text-slate-800 break-words">
      {lines.map((rawLine, index) => {
        const line = rawLine.trimEnd();
        const trimmed = line.trim();

        if (!trimmed) {
          return <div key={`sp-${index}`} className="h-1" />;
        }
        if (trimmed === '---') {
          return <hr key={`hr-${index}`} className="border-slate-200 my-2" />;
        }
        if (trimmed.startsWith('### ')) {
          return (
            <h4 key={`h4-${index}`} className="text-sm font-semibold text-slate-900 pt-1">
              {renderInline(trimmed.slice(4), `h4-${index}`)}
            </h4>
          );
        }
        if (trimmed.startsWith('## ')) {
          return (
            <h3 key={`h3-${index}`} className="text-base font-semibold text-slate-900 pt-1">
              {renderInline(trimmed.slice(3), `h3-${index}`)}
            </h3>
          );
        }
        if (trimmed.startsWith('* ') || trimmed.startsWith('- ') || trimmed.startsWith('• ')) {
          const content = trimmed.slice(2);
          return (
            <div key={`li-${index}`} className="flex items-start gap-2 pl-1">
              <span aria-hidden="true" className="text-slate-400 select-none">
                •
              </span>
              <div className="flex-1 min-w-0">{renderInline(content, `li-${index}`)}</div>
            </div>
          );
        }

        return <p key={`p-${index}`}>{renderInline(line, `p-${index}`)}</p>;
      })}
    </div>
  );
}

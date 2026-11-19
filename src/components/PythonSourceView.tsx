import { useState } from 'react';
import { Archive, Check, Cloud, Copy, Download, FileCode2, ShieldCheck } from 'lucide-react';
import { PYTHON_SOURCE_FILES, type PythonSourceFile } from '../data/pythonBundle';
import { createZipBlob } from '../lib/zipExport';

export function PythonSourceView() {
  const [activeId, setActiveId] = useState<PythonSourceFile['id']>('bot.py');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const activeFile =
    PYTHON_SOURCE_FILES.find((f) => f.id === activeId) ?? PYTHON_SOURCE_FILES[0];

  const handleCopy = async (file: PythonSourceFile) => {
    try {
      await navigator.clipboard.writeText(file.content);
      setCopiedId(file.id);
      setTimeout(() => setCopiedId(null), 1800);
    } catch {
      setCopiedId(null);
    }
  };

  const handleDownload = (file: PythonSourceFile) => {
    const blob = new Blob([file.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const handleDownloadZip = () => {
    const blob = createZipBlob(
      PYTHON_SOURCE_FILES.map((file) => ({
        name: file.filename,
        content: file.content,
      }))
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'ca-rose-bot-24x7.zip';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-3.5 border-b border-slate-200 bg-slate-50/70">
            <div className="flex items-center gap-1 overflow-x-auto" role="tablist" aria-label="Python source files">
              {PYTHON_SOURCE_FILES.map((file) => {
                const isActive = file.id === activeFile.id;
                return (
                  <button
                    key={file.id}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => setActiveId(file.id)}
                    className={`px-3 py-1.5 text-xs font-mono font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      isActive
                        ? 'bg-blue-700 text-white'
                        : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
                    }`}
                  >
                    {file.filename}
                  </button>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => void handleCopy(activeFile)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {copiedId === activeFile.id ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-600" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    Copy File
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => handleDownload(activeFile)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                Download
              </button>
              <button
                type="button"
                onClick={handleDownloadZip}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Archive className="w-3.5 h-3.5" />
                Download ZIP (24/7 Deploy)
              </button>
            </div>
          </div>

          <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between gap-4 bg-white">
            <div className="flex items-center gap-2 text-xs text-slate-600">
              <FileCode2 className="w-4 h-4 text-slate-400 shrink-0" />
              <span>{activeFile.description}</span>
            </div>
            <span className="text-xs font-mono tabular-nums text-slate-400 shrink-0">
              {activeFile.content.split('\n').length} lines
            </span>
          </div>

          <pre className="p-5 text-xs leading-6 font-mono text-slate-800 bg-slate-50/50 overflow-x-auto max-h-[580px] overflow-y-auto">
            <code>{activeFile.content}</code>
          </pre>
        </div>

        <aside className="lg:col-span-4 space-y-5">
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3.5">
            <div className="flex items-center gap-2">
              <Cloud className="w-4 h-4 text-blue-700 shrink-0" />
              <h3 className="text-sm font-semibold text-slate-900">Run 24/7 Without AI Studio</h3>
            </div>
            <p className="text-xs leading-relaxed text-slate-600">
              Google AI Studio&apos;s preview workspace sleeps automatically when you close it. To keep your Telegram bot online 24/7 even when AI Studio is closed, click{' '}
              <strong className="text-slate-900">Download ZIP (24/7 Deploy)</strong> and upload the bundle to any always-on Python or Docker host:
            </p>
            <ul className="space-y-2 text-xs text-slate-600 list-disc list-inside">
              <li>
                <span className="font-medium text-slate-900">Render / Koyeb / Railway / Fly.io:</span>{' '}
                Upload <code className="font-mono bg-slate-100 px-1 py-0.5 rounded">ca-rose-bot-24x7.zip</code> (includes{' '}
                <code className="font-mono bg-slate-100 px-1 py-0.5 rounded">Dockerfile</code>,{' '}
                <code className="font-mono bg-slate-100 px-1 py-0.5 rounded">render.yaml</code>, and{' '}
                <code className="font-mono bg-slate-100 px-1 py-0.5 rounded">Procfile</code> + built-in <code className="font-mono bg-slate-100 px-1 py-0.5 rounded">/healthz</code>).
              </li>
              <li>
                <span className="font-medium text-slate-900">Environment Variables:</span>{' '}
                Set <code className="font-mono bg-slate-100 px-1 py-0.5 rounded">TELEGRAM_BOT_TOKEN</code> and{' '}
                <code className="font-mono bg-slate-100 px-1 py-0.5 rounded">GEMINI_API_KEY</code> in the host dashboard (stop polling in AI Studio or use a dedicated token if both run simultaneously).
              </li>
            </ul>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-blue-700 shrink-0" />
              <h3 className="text-sm font-semibold text-slate-900">BotFather & Deployment Checklist</h3>
            </div>

            <ol className="space-y-3 text-sm text-slate-600 list-decimal list-inside">
              <li>
                <span className="font-medium text-slate-900">Disable Group Privacy Mode:</span>{' '}
                In <code className="font-mono text-xs bg-slate-100 px-1 py-0.5 rounded">@BotFather</code>, open{' '}
                <code className="font-mono text-xs bg-slate-100 px-1 py-0.5 rounded">/mybots</code>, choose your bot, select{' '}
                <span className="font-medium text-slate-800">Bot Settings → Group Privacy → Turn off</span> so the bot tracks members for{' '}
                <code className="font-mono text-xs bg-slate-100 px-1 py-0.5 rounded">/tagall</code> and reads audio captions.
              </li>
              <li>
                <span className="font-medium text-slate-900">Grant Group Admin Rights:</span>{' '}
                Promote the bot to Admin with permissions for Delete Messages, Ban Users, Pin Messages, and Add New Admins (for <code className="font-mono text-xs bg-slate-100 px-1 py-0.5 rounded">/promote</code> & <code className="font-mono text-xs bg-slate-100 px-1 py-0.5 rounded">/demote</code>).
              </li>
              <li>
                <span className="font-medium text-slate-900">Configure Environment Secrets:</span>{' '}
                Copy <code className="font-mono text-xs bg-slate-100 px-1 py-0.5 rounded">.env.example</code> to{' '}
                <code className="font-mono text-xs bg-slate-100 px-1 py-0.5 rounded">.env</code> and set{' '}
                <code className="font-mono text-xs bg-slate-100 px-1 py-0.5 rounded">TELEGRAM_BOT_TOKEN</code> and{' '}
                <code className="font-mono text-xs bg-slate-100 px-1 py-0.5 rounded">GEMINI_API_KEY</code>.
              </li>
              <li>
                <span className="font-medium text-slate-900">Install & Launch Python Runner:</span>
                <pre className="mt-2 p-3 rounded-lg bg-slate-900 text-slate-100 font-mono text-xs overflow-x-auto">
                  {`python -m venv venv\nsource venv/bin/activate\npip install -r requirements.txt\npython bot.py`}
                </pre>
              </li>
            </ol>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2.5">
            <h3 className="text-sm font-semibold text-slate-900">Chunked Tag All & Permission Debug</h3>
            <p className="text-xs leading-relaxed text-slate-600">
              Before running <code className="font-mono bg-slate-100 px-1 py-0.5 rounded">/tagall</code>, the bot verifies its Admin status and required rights (Delete Messages, Ban Users) and sends a permission debug report if anything is missing. Tracked members are then tagged sequentially in chunks of 5 mentions (≤ 3800 chars) so large groups with hundreds of members never hit Telegram rejection limits.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

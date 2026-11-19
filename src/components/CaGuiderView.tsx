import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { BookOpen, Mic, Paperclip, Send, Square, X } from 'lucide-react';
import { FormattedText } from './FormattedText';

interface CaTurn {
  id: number;
  role: 'student' | 'mentor';
  text: string;
  audioName?: string;
  timestamp: string;
}

const CA_STARTERS = [
  {
    level: 'CA Final · Direct Tax',
    prompt: 'Explain the conditions and turnover thresholds under Section 44AD & 44ADA for AY 2026-27.',
  },
  {
    level: 'CA Final · FR (Ind AS)',
    prompt: 'How does a lessee measure Right-of-Use (ROU) asset and lease liability under Ind AS 116?',
  },
  {
    level: 'CA Inter · Audit & Ethics',
    prompt: 'What are the key elements of an Independent Auditor Report under SA 700 (Revised)?',
  },
  {
    level: 'CA Inter · Costing',
    prompt: 'Give a crisp exam revision framework for Standard Costing material & labour variances.',
  },
  {
    level: 'CA Foundation · Law',
    prompt: 'Distinguish between Coercion and Undue Influence under the Indian Contract Act, 1872.',
  },
  {
    level: 'Domain Guardrail Test',
    prompt: 'Can you recommend the top 5 sci-fi movies to watch this weekend?',
  },
];

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      resolve(result.includes(',') ? result.split(',')[1] : result);
    };
    reader.onerror = () => reject(new Error('Failed to read audio.'));
    reader.readAsDataURL(blob);
  });
}

export function CaGuiderView() {
  const [turns, setTurns] = useState<CaTurn[]>([
    {
      id: 1,
      role: 'mentor',
      text: 'Welcome to the CA-Specialized Gemini Study Guider. Ask any Chartered Accountancy doubt across Foundation, Intermediate, Final, or Articleship — or record/upload a voice answer for evaluation against ICAI standards, sections, Ind AS, and SAs.',
      timestamp: 'Ready',
    },
  ]);
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [audioAttachment, setAudioAttachment] = useState<{
    base64: string;
    mime: string;
    name: string;
  } | null>(null);

  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const submitQuery = async (overridePrompt?: string) => {
    const queryText = (overridePrompt ?? prompt).trim();
    if (!queryText && !audioAttachment) {
      setErrorMsg('Type a CA question or attach a voice/audio note first.');
      return;
    }

    const nowStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const studentTurn: CaTurn = {
      id: Date.now(),
      role: 'student',
      text: queryText || '(Voice/Audio CA question or answer recitation)',
      audioName: audioAttachment?.name,
      timestamp: nowStr,
    };

    setTurns((prev) => [...prev, studentTurn]);
    if (overridePrompt === undefined) {
      setPrompt('');
    }
    const pendingAudio = audioAttachment;
    setAudioAttachment(null);
    setLoading(true);
    setErrorMsg(null);

    try {
      const res = await fetch('/api/ca-guide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: queryText,
          audioBase64: pendingAudio?.base64,
          audioMime: pendingAudio?.mime,
        }),
      });
      const data = (await res.json()) as { answer?: string; error?: string };
      if (!res.ok) {
        setErrorMsg(data.error || 'Gemini CA Guider returned an error.');
      } else {
        setTurns((prev) => [
          ...prev,
          {
            id: Date.now() + 1,
            role: 'mentor',
            text: data.answer || 'No response received.',
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          },
        ]);
      }
    } catch {
      setErrorMsg('Network error communicating with CA Study Guider.');
    } finally {
      setLoading(false);
    }
  };

  const handleFormSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submitQuery();
  };

  const handleToggleRecord = async () => {
    setErrorMsg(null);
    if (isRecording) {
      mediaRecorderRef.current?.stop();
      setIsRecording(false);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setErrorMsg('Microphone recording is unavailable in this browser. Attach an audio file instead.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';
      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: mimeType });
        const base64 = await blobToBase64(blob);
        setAudioAttachment({
          base64,
          mime: mimeType,
          name: `ca-voice.${mimeType.includes('ogg') ? 'ogg' : 'webm'}`,
        });
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
    } catch {
      setErrorMsg('Microphone access denied. You can upload an audio file instead.');
    }
  };

  const handleFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      setErrorMsg('Audio file must be under 20 MB.');
      return;
    }
    const base64 = await blobToBase64(file);
    setAudioAttachment({
      base64,
      mime: file.type || 'audio/mpeg',
      name: file.name,
    });
    setErrorMsg(null);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      {/* Left Rail: CA Syllabus Prompts */}
      <aside className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-blue-700 shrink-0" />
          <h2 className="text-sm font-semibold text-slate-900">ICAI Study Starters</h2>
        </div>
        <p className="text-xs text-slate-600 leading-relaxed">
          Strictly scoped to Chartered Accountancy exams. Non-CA topics are politely declined per the system instruction.
        </p>
        <div className="space-y-2">
          {CA_STARTERS.map((item) => (
            <button
              key={item.level}
              type="button"
              disabled={loading}
              onClick={() => void submitQuery(item.prompt)}
              className="w-full text-left p-3 rounded-lg border border-slate-200 hover:border-blue-300 hover:bg-blue-50/40 transition-colors space-y-1 cursor-pointer disabled:opacity-50"
            >
              <div className="text-xs font-semibold text-blue-700">{item.level}</div>
              <div className="text-xs text-slate-700 leading-snug">{item.prompt}</div>
            </button>
          ))}
        </div>
      </aside>

      {/* Main Mentor Desk */}
      <section
        aria-label="CA Gemini AI Mentor Conversation"
        className="lg:col-span-8 bg-white border border-slate-200 rounded-xl flex flex-col overflow-hidden"
      >
        <div className="px-5 py-3.5 border-b border-slate-200 bg-slate-50/70 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">CA Exam Mentor & Voice Evaluator</h2>
            <p className="text-xs text-slate-500">
              Text + Multimodal Audio (OGG, MP3, WAV, WebM up to 20 MB)
            </p>
          </div>
          <span className="text-xs font-mono text-slate-500 whitespace-nowrap">Gemini CA Mode</span>
        </div>

        <div className="p-5 space-y-4 h-[460px] overflow-y-auto bg-slate-50/30">
          {turns.map((turn) => (
            <article
              key={turn.id}
              className={`p-4 rounded-xl border ${
                turn.role === 'mentor'
                  ? 'bg-white border-slate-200'
                  : 'bg-blue-50/50 border-blue-200'
              }`}
            >
              <div className="flex items-center justify-between gap-2 mb-1.5 text-xs">
                <span className="font-semibold text-slate-900">
                  {turn.role === 'mentor' ? 'CA Rose Guider (AI Mentor)' : 'CA Student'}
                </span>
                <span className="font-mono tabular-nums text-slate-400">{turn.timestamp}</span>
              </div>
              {turn.audioName && (
                <div className="mb-2 inline-flex items-center gap-1.5 text-xs font-mono text-blue-700 bg-white border border-blue-200 px-2.5 py-1 rounded-md">
                  <Mic className="w-3.5 h-3.5" />
                  <span>{turn.audioName}</span>
                </div>
              )}
              <FormattedText text={turn.text} />
            </article>
          ))}
          {loading && (
            <div className="p-4 rounded-xl border border-slate-200 bg-white text-xs text-slate-500">
              Analyzing your CA query with ICAI reference standards...
            </div>
          )}
        </div>

        <form onSubmit={handleFormSubmit} className="p-4 border-t border-slate-200 bg-white space-y-2.5">
          {audioAttachment && (
            <div className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg bg-blue-50 text-xs text-blue-800">
              <span className="font-mono truncate">Voice / Audio ready: {audioAttachment.name}</span>
              <button
                type="button"
                aria-label="Remove attached audio"
                onClick={() => setAudioAttachment(null)}
                className="text-blue-700 hover:text-blue-900 cursor-pointer shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {errorMsg && (
            <div role="alert" className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {errorMsg}
            </div>
          )}

          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              aria-label="Upload CA audio note"
              onChange={(e) => void handleFileUpload(e)}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Upload audio question or answer"
              className="p-2.5 text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors shrink-0 cursor-pointer"
            >
              <Paperclip className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => void handleToggleRecord()}
              aria-label={isRecording ? 'Stop recording CA voice note' : 'Record CA voice note'}
              className={`p-2.5 rounded-lg transition-colors shrink-0 cursor-pointer ${
                isRecording
                  ? 'bg-red-600 text-white hover:bg-red-700'
                  : 'bg-slate-100 text-slate-600 hover:text-slate-900 hover:bg-slate-200'
              }`}
            >
              {isRecording ? <Square className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </button>
            <input
              type="text"
              aria-label="Ask a CA exam question"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Ask any CA Foundation, Inter, Final, Tax, Audit, Ind AS, or Articleship question..."
              className="flex-1 min-w-0 text-sm px-3.5 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
            <button
              type="submit"
              disabled={loading}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              <Send className="w-4 h-4" />
              {loading ? 'Thinking...' : 'Ask Mentor'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

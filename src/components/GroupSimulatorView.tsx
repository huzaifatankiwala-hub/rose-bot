import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  CloudSun,
  Mic,
  Paperclip,
  Pin,
  Reply,
  Send,
  Square,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { buildTagAllMessage } from '../lib/botLogic';
import type { ChatMessage, GroupMember, GroupSettings, WeatherResult } from '../types';
import { Avatar } from './Avatar';
import { FormattedText } from './FormattedText';

interface GroupSimulatorViewProps {
  settings: GroupSettings;
  members: GroupMember[];
  messages: ChatMessage[];
  pinnedMessage: ChatMessage | null;
  activeSenderId: number;
  onChangeSender: (id: number) => void;
  onRefreshState: () => Promise<void>;
  onInspectMember: (member: GroupMember) => void;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('Failed to read audio file.'));
    reader.readAsDataURL(blob);
  });
}

export function GroupSimulatorView({
  settings,
  members,
  messages,
  pinnedMessage,
  activeSenderId,
  onChangeSender,
  onRefreshState,
  onInspectMember,
}: GroupSimulatorViewProps) {
  const [inputText, setInputText] = useState('');
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [sending, setSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Audio / voice state
  const [audioAttachment, setAudioAttachment] = useState<{
    base64: string;
    mime: string;
    name: string;
  } | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const feedEndRef = useRef<HTMLDivElement | null>(null);

  // Right rail state: weather & simulate join
  const [weatherCity, setWeatherCity] = useState('Delhi');
  const [weatherData, setWeatherData] = useState<WeatherResult | null>(null);
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [weatherError, setWeatherError] = useState<string | null>(null);

  const [joinName, setJoinName] = useState('');
  const [joinUsername, setJoinUsername] = useState('');
  const [joining, setJoining] = useState(false);

  const humanSenders = members.filter((m) => !m.is_bot);
  const activeSender =
    humanSenders.find((m) => m.user_id === activeSenderId) ?? humanSenders[0];

  const memberAvatarMap = new Map<number, string | null>(
    members.map((m) => [m.user_id, m.avatar_url])
  );

  const tagPreview = buildTagAllMessage(members, 'Revision Alert');

  useEffect(() => {
    feedEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  useEffect(() => {
    let active = true;
    const loadInitialWeather = async () => {
      setWeatherLoading(true);
      try {
        const res = await fetch(`/api/weather?city=${encodeURIComponent('Delhi')}`);
        if (res.ok && active) {
          setWeatherData((await res.json()) as WeatherResult);
        }
      } catch {
        // Ignore silent initial weather load failure
      } finally {
        if (active) setWeatherLoading(false);
      }
    };
    void loadInitialWeather();
    return () => {
      active = false;
    };
  }, []);

  const handleSendCommand = async (overrideText?: string) => {
    const textToSend = (overrideText ?? inputText).trim();
    if (!textToSend && !audioAttachment) {
      setErrorMsg('Enter a message, slash command, or attach a voice/audio note.');
      return;
    }
    if (!activeSender) {
      setErrorMsg('No active sender selected.');
      return;
    }

    setSending(true);
    setErrorMsg(null);
    try {
      const res = await fetch('/api/chat/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          senderId: activeSender.user_id,
          text: textToSend,
          replyToId: replyTo?.id ?? null,
          audioBase64: audioAttachment?.base64,
          audioMime: audioAttachment?.mime,
          audioName: audioAttachment?.name,
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setErrorMsg(data.error || 'Failed to send message.');
      } else {
        if (overrideText === undefined) {
          setInputText('');
        }
        setReplyTo(null);
        setAudioAttachment(null);
        await onRefreshState();
      }
    } catch {
      setErrorMsg('Network error while sending command.');
    } finally {
      setSending(false);
    }
  };

  const handleFormSubmit = (e: FormEvent) => {
    e.preventDefault();
    void handleSendCommand();
  };

  const handleToggleRecord = async () => {
    setErrorMsg(null);
    if (isRecording) {
      mediaRecorderRef.current?.stop();
      setIsRecording(false);
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setErrorMsg('Microphone recording is unavailable in this browser. Use Upload Audio instead.');
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
          name: `voice-note.${mimeType.includes('ogg') ? 'ogg' : 'webm'}`,
        });
        if (!inputText.trim()) {
          setInputText('@CA_Rose_Bot ');
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
    } catch {
      setErrorMsg('Microphone permission denied. You can still attach an audio file.');
    }
  };

  const handleAudioFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      setErrorMsg('Audio file exceeds Telegram & Gemini 20 MB inline limit.');
      return;
    }
    try {
      const base64 = await blobToBase64(file);
      setAudioAttachment({
        base64,
        mime: file.type || 'audio/mpeg',
        name: file.name,
      });
      if (!inputText.trim()) {
        setInputText('@CA_Rose_Bot ');
      }
      setErrorMsg(null);
    } catch {
      setErrorMsg('Could not read the selected audio file.');
    }
  };

  const handleWeatherLookup = async (e: FormEvent) => {
    e.preventDefault();
    if (!weatherCity.trim()) {
      setWeatherError('Enter a city name.');
      return;
    }
    setWeatherLoading(true);
    setWeatherError(null);
    try {
      const res = await fetch(`/api/weather?city=${encodeURIComponent(weatherCity.trim())}`);
      const data = (await res.json()) as WeatherResult & { error?: string };
      if (!res.ok) {
        setWeatherError(data.error || 'City not found.');
      } else {
        setWeatherData(data);
      }
    } catch {
      setWeatherError('Unable to reach weather service.');
    } finally {
      setWeatherLoading(false);
    }
  };

  const handleSimulateJoin = async (e: FormEvent) => {
    e.preventDefault();
    if (!joinName.trim()) return;
    setJoining(true);
    setErrorMsg(null);
    try {
      const res = await fetch('/api/members/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: joinName.trim(),
          username: joinUsername.trim() || undefined,
        }),
      });
      if (res.ok) {
        setJoinName('');
        setJoinUsername('');
        await onRefreshState();
      }
    } finally {
      setJoining(false);
    }
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
      {/* Main Group Simulator Thread */}
      <section
        aria-label="Telegram Group Command Simulator"
        className="xl:col-span-8 bg-white border border-slate-200 rounded-xl flex flex-col overflow-hidden"
      >
        {/* Group Sub-header + Sender Role Switcher */}
        <div className="px-5 py-3.5 border-b border-slate-200 bg-slate-50/70 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-slate-900 truncate">{settings.chat_title}</h2>
            <p className="text-xs text-slate-500 tabular-nums">
              {members.filter((m) => m.is_active && !m.is_bot).length} active members · Chat ID{' '}
              <span className="font-mono">{settings.chat_id}</span>
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <label htmlFor="active-sender-select" className="text-xs font-medium text-slate-600 whitespace-nowrap">
              Send as
            </label>
            <select
              id="active-sender-select"
              value={activeSender?.user_id ?? ''}
              onChange={(e) => onChangeSender(Number(e.target.value))}
              className="text-xs font-medium text-slate-900 bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-600"
            >
              {humanSenders.map((m) => (
                <option key={m.user_id} value={m.user_id} disabled={!m.is_active}>
                  {m.full_name} ({m.role}
                  {!m.is_active ? ' · Banned' : m.is_muted ? ' · Muted' : ''})
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Pinned Message Banner */}
        {pinnedMessage && (
          <div className="px-5 py-2.5 border-b border-slate-200 bg-blue-50/60 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <Pin className="w-3.5 h-3.5 text-blue-700 shrink-0" />
              <p className="text-xs text-slate-700 truncate">
                <span className="font-semibold text-slate-900">Pinned: </span>
                {pinnedMessage.text}
              </p>
            </div>
            {activeSender && (activeSender.role === 'owner' || activeSender.role === 'administrator') && (
              <button
                type="button"
                onClick={() => void handleSendCommand('/unpin')}
                className="text-xs font-medium text-blue-700 hover:text-blue-900 whitespace-nowrap shrink-0 cursor-pointer"
              >
                Unpin
              </button>
            )}
          </div>
        )}

        {/* Message Feed */}
        <div
          data-testid="simulator-feed"
          className="p-5 space-y-4 h-[460px] overflow-y-auto bg-slate-50/40"
        >
          {messages.map((msg) => {
            const avatar = memberAvatarMap.get(msg.sender_id) ?? null;
            const senderMember = members.find((m) => m.user_id === msg.sender_id);
            return (
              <article
                key={msg.id}
                className={`flex items-start gap-3 ${
                  msg.is_bot ? 'bg-white border border-slate-200 rounded-xl p-4' : ''
                }`}
              >
                <Avatar src={avatar} name={msg.sender_name} isBot={msg.is_bot} />
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs min-w-0">
                      <span className="font-semibold text-slate-900">{msg.sender_name}</span>
                      {msg.sender_username && (
                        <span className="font-mono text-slate-500 truncate max-w-[140px]">
                          @{msg.sender_username}
                        </span>
                      )}
                      <span aria-hidden="true" className="text-slate-300">
                        ·
                      </span>
                      <span className="text-slate-500 capitalize">{msg.sender_role}</span>
                      <span aria-hidden="true" className="text-slate-300">
                        ·
                      </span>
                      <span className="font-mono tabular-nums text-slate-400 whitespace-nowrap">
                        {msg.created_at}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => setReplyTo(msg)}
                        aria-label={`Reply to ${msg.sender_name} message ${msg.id}`}
                        className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-blue-700 cursor-pointer"
                      >
                        <Reply className="w-3.5 h-3.5" />
                        Reply
                      </button>
                      {!msg.is_bot && senderMember && (
                        <button
                          type="button"
                          onClick={() => onInspectMember(senderMember)}
                          className="text-xs text-slate-500 hover:text-slate-900 cursor-pointer"
                        >
                          Info
                        </button>
                      )}
                      {activeSender &&
                        (activeSender.role === 'owner' || activeSender.role === 'administrator') && (
                          <button
                            type="button"
                            onClick={() => {
                              setReplyTo(msg);
                              void handleSendCommand('/pin');
                            }}
                            aria-label={`Pin message ${msg.id}`}
                            className="text-xs text-slate-500 hover:text-blue-700 cursor-pointer"
                          >
                            Pin
                          </button>
                        )}
                    </div>
                  </div>

                  {msg.reply_to_snippet && (
                    <div className="text-xs text-slate-500 bg-slate-100 rounded-md px-2.5 py-1.5 truncate">
                      Replying to {msg.reply_to_snippet}
                    </div>
                  )}

                  {msg.audio_name && (
                    <div className="inline-flex items-center gap-1.5 text-xs font-mono text-blue-700 bg-blue-50 px-2.5 py-1 rounded-md">
                      <Mic className="w-3.5 h-3.5" />
                      <span>{msg.audio_name}</span>
                    </div>
                  )}

                  {msg.is_bot ? (
                    <FormattedText text={msg.text} />
                  ) : (
                    <div className="text-sm leading-relaxed text-slate-800 whitespace-pre-wrap break-words">
                      {msg.text}
                    </div>
                  )}
                </div>
              </article>
            );
          })}
          <div ref={feedEndRef} />
        </div>

        {/* Quick Command Bar */}
        <div className="px-5 py-2.5 border-t border-slate-200 bg-white flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-slate-500 mr-1 whitespace-nowrap">Quick test:</span>
          {[
            { label: '/tagall Mock Test 7 PM', cmd: '/tagall Mock Test at 7 PM IST!' },
            { label: '/weather Delhi', cmd: '/weather Delhi' },
            { label: '/info @rohan_ca', cmd: '/info @rohan_ca' },
            { label: '/promote @rohan_ca', cmd: '/promote @rohan_ca' },
            { label: '/mute @rohan_ca 30m', cmd: '/mute @rohan_ca 30m' },
            { label: '/warn @rohan_ca', cmd: '/warn @rohan_ca' },
            { label: '/rules', cmd: '/rules' },
            {
              label: '@CA_Rose_Bot Ind AS 116',
              cmd: '@CA_Rose_Bot Explain lessee accounting under Ind AS 116 in 4 bullets.',
            },
          ].map((preset) => (
            <button
              key={preset.label}
              type="button"
              disabled={sending}
              onClick={() => void handleSendCommand(preset.cmd)}
              className="px-2.5 py-1 text-xs font-mono text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              {preset.label}
            </button>
          ))}
        </div>

        {/* Composer */}
        <form onSubmit={handleFormSubmit} className="p-4 border-t border-slate-200 bg-white space-y-2.5">
          {replyTo && (
            <div className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg bg-slate-100 text-xs text-slate-700">
              <span className="truncate">
                Replying to <strong>{replyTo.sender_name}</strong>: {replyTo.text}
              </span>
              <button
                type="button"
                aria-label="Clear reply target"
                onClick={() => setReplyTo(null)}
                className="text-slate-500 hover:text-slate-900 cursor-pointer shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {audioAttachment && (
            <div className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg bg-blue-50 text-xs text-blue-800">
              <span className="font-mono truncate">Audio attached: {audioAttachment.name}</span>
              <button
                type="button"
                aria-label="Remove audio attachment"
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
              aria-label="Upload audio clip"
              onChange={(e) => void handleAudioFileChange(e)}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach audio file"
              className="p-2.5 text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors shrink-0 cursor-pointer"
            >
              <Paperclip className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => void handleToggleRecord()}
              aria-label={isRecording ? 'Stop voice recording' : 'Record voice note'}
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
              aria-label="Group message or bot command"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="Type a command (/ban, /mute 30, /tagall, /weather Delhi, /info @rohan_ca) or @CA_Rose_Bot..."
              className="flex-1 min-w-0 text-sm px-3.5 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
            />

            <button
              type="submit"
              disabled={sending}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              <Send className="w-4 h-4" />
              {sending ? 'Sending...' : 'Send'}
            </button>
          </div>
        </form>
      </section>

      {/* Right Inspector Rail */}
      <aside className="xl:col-span-4 space-y-5">
        {/* Single-Message Tag All Reach */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Users className="w-4 h-4 text-blue-700 shrink-0" />
              <h3 className="text-sm font-semibold text-slate-900">Single-Message /tagall Reach</h3>
            </div>
            <span className="text-xs font-mono tabular-nums text-slate-500">
              {tagPreview.chunkCount} {tagPreview.chunkCount === 1 ? 'message' : 'messages'}
            </span>
          </div>
          <p className="text-xs text-slate-600 leading-relaxed">
            Packs{' '}
            <strong className="tabular-nums text-slate-900">
              {tagPreview.taggedCount}
            </strong>{' '}
            active members into {tagPreview.chunkCount} safe message{tagPreview.chunkCount === 1 ? '' : 's'} (up to 100 mentions/message, ≤ 3800 chars).
          </p>
          <button
            type="button"
            disabled={sending}
            onClick={() => void handleSendCommand('/tagall Evening CA Revision Call!')}
            className="w-full px-3.5 py-2 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
          >
            Run /tagall in Simulator
          </button>
        </div>

        {/* Live Open-Meteo Weather Card */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3.5">
          <div className="flex items-center gap-2">
            <CloudSun className="w-4 h-4 text-blue-700 shrink-0" />
            <h3 className="text-sm font-semibold text-slate-900">Live Weather (/weather)</h3>
          </div>

          <form onSubmit={(e) => void handleWeatherLookup(e)} className="flex items-center gap-2">
            <input
              type="text"
              aria-label="City name for weather lookup"
              value={weatherCity}
              onChange={(e) => setWeatherCity(e.target.value)}
              placeholder="City (e.g. Mumbai)"
              className="flex-1 min-w-0 text-xs px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
            <button
              type="submit"
              disabled={weatherLoading}
              className="px-3 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              {weatherLoading ? 'Loading' : 'Check'}
            </button>
          </form>

          {weatherError && (
            <p className="text-xs text-red-700">{weatherError}</p>
          )}

          {weatherData && !weatherError && (
            <div className="pt-1 border-t border-slate-100 space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-medium text-slate-900 truncate">{weatherData.place}</span>
                <span className="text-lg font-semibold font-mono tabular-nums text-slate-900 shrink-0">
                  {weatherData.temperatureC}°C
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs text-slate-600 tabular-nums">
                <div>Condition: {weatherData.condition}</div>
                <div>Feels like: {weatherData.apparentTemperatureC}°C</div>
                <div>
                  Min/Max: {weatherData.minTempC}° / {weatherData.maxTempC}°
                </div>
                <div>
                  Humidity: {weatherData.humidityPct}% · {weatherData.windKmh} km/h
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Simulate Member Join (Tests Welcome Message) */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <UserPlus className="w-4 h-4 text-blue-700 shrink-0" />
              <h3 className="text-sm font-semibold text-slate-900">Simulate Member Join</h3>
            </div>
            <span className="text-xs text-slate-500">
              Welcome: {settings.welcome_enabled ? 'ON' : 'OFF'}
            </span>
          </div>

          <form onSubmit={(e) => void handleSimulateJoin(e)} className="space-y-2.5">
            <input
              type="text"
              aria-label="New member full name"
              value={joinName}
              onChange={(e) => setJoinName(e.target.value)}
              placeholder="Student Full Name (e.g. Ananya Roy)"
              className="w-full text-xs px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
            <div className="flex items-center gap-2">
              <input
                type="text"
                aria-label="New member username"
                value={joinUsername}
                onChange={(e) => setJoinUsername(e.target.value)}
                placeholder="@username (optional)"
                className="flex-1 min-w-0 text-xs px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
              <button
                type="submit"
                disabled={joining || !joinName.trim()}
                className="px-3.5 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
              >
                {joining ? 'Joining...' : 'Add Join'}
              </button>
            </div>
          </form>
        </div>
      </aside>
    </div>
  );
}

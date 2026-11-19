import { useEffect, useState, type FormEvent } from 'react';
import {
  Cloud,
  Info,
  KeyRound,
  Search,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Unplug,
  X,
} from 'lucide-react';
import type { GroupMember, GroupSettings, OwnerOverrideStatus, TelegramBridgeStatus } from '../types';
import { Avatar } from './Avatar';

interface MembersSettingsViewProps {
  settings: GroupSettings;
  members: GroupMember[];
  activeSenderId: number;
  inspectedMember: GroupMember | null;
  ownerOverride?: OwnerOverrideStatus;
  telegram?: TelegramBridgeStatus;
  onSelectInspect: (member: GroupMember | null) => void;
  onRefreshState: () => Promise<void>;
  onOpenPythonSource?: () => void;
}

type MemberFilter = 'all' | 'active' | 'muted' | 'banned' | 'warned';

export function MembersSettingsView({
  settings,
  members,
  activeSenderId,
  inspectedMember,
  ownerOverride,
  telegram,
  onSelectInspect,
  onRefreshState,
  onOpenPythonSource,
}: MembersSettingsViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<MemberFilter>('all');
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);

  // 24/7 Hosting & Webhook state
  const [webhookInput, setWebhookInput] = useState(
    telegram?.webhookUrl ? telegram.webhookUrl.replace(/\/api\/telegram\/webhook$/, '') : ''
  );
  const [hostingBusy, setHostingBusy] = useState(false);
  const [hostingMsg, setHostingMsg] = useState<string | null>(null);
  const [hostingErr, setHostingErr] = useState<string | null>(null);

  // Settings form state
  const [chatTitle, setChatTitle] = useState(settings.chat_title);
  const [welcomeEnabled, setWelcomeEnabled] = useState(settings.welcome_enabled);
  const [welcomeText, setWelcomeText] = useState(settings.welcome_text);
  const [rulesText, setRulesText] = useState(settings.rules_text);
  const [maxWarns, setMaxWarns] = useState(settings.max_warns);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsSavedMsg, setSettingsSavedMsg] = useState<string | null>(null);

  // Owner MTProto Override state
  const [overrideMode, setOverrideMode] = useState<'login' | 'session'>('login');
  const [apiIdInput, setApiIdInput] = useState('');
  const [apiHashInput, setApiHashInput] = useState('');
  const [phoneInput, setPhoneInput] = useState('');
  const [phoneCodeInput, setPhoneCodeInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [sessionStringInput, setSessionStringInput] = useState('');
  const [codeSent, setCodeSent] = useState(Boolean(ownerOverride?.pendingLogin?.active));
  const [awaitingPassword, setAwaitingPassword] = useState(Boolean(ownerOverride?.pendingLogin?.awaitingPassword));
  const [overrideBusy, setOverrideBusy] = useState(false);
  const [overrideMsg, setOverrideMsg] = useState<string | null>(null);
  const [overrideErr, setOverrideErr] = useState<string | null>(null);

  useEffect(() => {
    setChatTitle(settings.chat_title);
    setWelcomeEnabled(settings.welcome_enabled);
    setWelcomeText(settings.welcome_text);
    setRulesText(settings.rules_text);
    setMaxWarns(settings.max_warns);
  }, [settings]);

  useEffect(() => {
    if (ownerOverride?.pendingLogin) {
      setCodeSent(ownerOverride.pendingLogin.active);
      setAwaitingPassword(ownerOverride.pendingLogin.awaitingPassword);
    }
  }, [ownerOverride]);

  useEffect(() => {
    if (telegram?.webhookUrl) {
      setWebhookInput(telegram.webhookUrl.replace(/\/api\/telegram\/webhook$/, ''));
    }
  }, [telegram?.webhookUrl]);

  const filteredMembers = members.filter((m) => {
    const q = searchQuery.trim().toLowerCase();
    const matchesSearch =
      !q ||
      m.full_name.toLowerCase().includes(q) ||
      (m.username ?? '').toLowerCase().includes(q) ||
      String(m.user_id).includes(q);

    if (!matchesSearch) return false;
    if (filter === 'active') return m.is_active && !m.is_muted;
    if (filter === 'muted') return m.is_muted;
    if (filter === 'banned') return !m.is_active;
    if (filter === 'warned') return m.warns > 0;
    return true;
  });

  const runModAction = async (
    targetUserId: number,
    action: 'warn' | 'resetwarns' | 'mute' | 'unmute' | 'ban' | 'unban' | 'kick' | 'promote' | 'demote'
  ) => {
    setActionMsg(null);
    setActionErr(null);
    try {
      const res = await fetch(`/api/members/${targetUserId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actorId: activeSenderId, action, muteMinutes: 30 }),
      });
      const data = (await res.json()) as { message?: string; error?: string; member?: GroupMember };
      if (!res.ok) {
        setActionErr(data.error || 'Moderation action failed.');
      } else {
        setActionMsg(data.message || 'Updated member.');
        if (data.member && inspectedMember?.user_id === targetUserId) {
          onSelectInspect(data.member);
        }
        await onRefreshState();
      }
    } catch {
      setActionErr('Network error performing moderation action.');
    }
  };

  const handleSaveSettings = async (e: FormEvent) => {
    e.preventDefault();
    setSavingSettings(true);
    setSettingsSavedMsg(null);
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_title: chatTitle,
          welcome_enabled: welcomeEnabled,
          welcome_text: welcomeText,
          rules_text: rulesText,
          max_warns: maxWarns,
        }),
      });
      if (res.ok) {
        setSettingsSavedMsg('Group settings saved.');
        await onRefreshState();
      }
    } finally {
      setSavingSettings(false);
    }
  };

  const handleSendOwnerCode = async (e: FormEvent) => {
    e.preventDefault();
    setOverrideMsg(null);
    setOverrideErr(null);

    const parsedId = Number(apiIdInput.trim());
    if (!Number.isInteger(parsedId) || parsedId <= 0) {
      setOverrideErr('Valid numeric Telegram API ID from my.telegram.org is required.');
      return;
    }
    if (apiHashInput.trim().length < 16) {
      setOverrideErr('Valid Telegram API Hash from my.telegram.org is required.');
      return;
    }
    if (!/^\+?\d{7,15}$/.test(phoneInput.trim().replace(/\s+/g, ''))) {
      setOverrideErr('Enter a valid phone number in international format, e.g. +919876543210.');
      return;
    }

    setOverrideBusy(true);
    try {
      const res = await fetch('/api/owner-override/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiId: apiIdInput,
          apiHash: apiHashInput,
          phoneNumber: phoneInput,
        }),
      });
      const data = (await res.json()) as { error?: string; phoneMasked?: string; isCodeViaApp?: boolean };
      if (!res.ok) {
        setOverrideErr(data.error || 'Could not send verification code.');
      } else {
        setCodeSent(true);
        setAwaitingPassword(false);
        setOverrideMsg(
          `Verification code sent to ${data.phoneMasked || phoneInput} via ${data.isCodeViaApp ? 'Telegram app' : 'SMS'}. Enter the code below.`
        );
        await onRefreshState();
      }
    } catch {
      setOverrideErr('Network error while requesting Telegram verification code.');
    } finally {
      setOverrideBusy(false);
    }
  };

  const handleVerifyOwnerCode = async (e: FormEvent) => {
    e.preventDefault();
    setOverrideMsg(null);
    setOverrideErr(null);

    if (!awaitingPassword && !phoneCodeInput.trim()) {
      setOverrideErr('Please enter the verification code sent by Telegram.');
      return;
    }
    if (awaitingPassword && !passwordInput.trim()) {
      setOverrideErr('Please enter your Telegram Two-Step Verification (2FA) password.');
      return;
    }

    setOverrideBusy(true);
    try {
      const res = await fetch('/api/owner-override/verify-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phoneCode: phoneCodeInput,
          password: passwordInput,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        requiresPassword?: boolean;
        message?: string;
        error?: string;
      };
      if (!res.ok) {
        setOverrideErr(data.error || 'Verification failed.');
      } else if (data.requiresPassword) {
        setAwaitingPassword(true);
        setOverrideMsg(data.message || 'Enter your Telegram Two-Step Verification (2FA) password.');
      } else {
        setCodeSent(false);
        setAwaitingPassword(false);
        setPhoneCodeInput('');
        setPasswordInput('');
        setOverrideMsg(data.message || 'Owner Override connected.');
        await onRefreshState();
      }
    } catch {
      setOverrideErr('Network error while verifying Telegram code.');
    } finally {
      setOverrideBusy(false);
    }
  };

  const handleConnectSessionString = async (e: FormEvent) => {
    e.preventDefault();
    setOverrideMsg(null);
    setOverrideErr(null);

    const parsedId = Number(apiIdInput.trim());
    if (!Number.isInteger(parsedId) || parsedId <= 0) {
      setOverrideErr('Valid numeric Telegram API ID from my.telegram.org is required.');
      return;
    }
    if (apiHashInput.trim().length < 16) {
      setOverrideErr('Valid Telegram API Hash from my.telegram.org is required.');
      return;
    }
    if (sessionStringInput.trim().length < 20) {
      setOverrideErr('Enter a valid OWNER_SESSION_STRING.');
      return;
    }

    setOverrideBusy(true);
    try {
      const res = await fetch('/api/owner-override/connect-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiId: apiIdInput,
          apiHash: apiHashInput,
          sessionString: sessionStringInput,
        }),
      });
      const data = (await res.json()) as { message?: string; error?: string };
      if (!res.ok) {
        setOverrideErr(data.error || 'Failed to connect Owner session string.');
      } else {
        setSessionStringInput('');
        setOverrideMsg(data.message || 'Owner Override connected.');
        await onRefreshState();
      }
    } catch {
      setOverrideErr('Network error connecting Owner session string.');
    } finally {
      setOverrideBusy(false);
    }
  };

  const handleDisconnectOwner = async () => {
    setOverrideBusy(true);
    setOverrideMsg(null);
    setOverrideErr(null);
    try {
      const res = await fetch('/api/owner-override/disconnect', { method: 'POST' });
      if (!res.ok) {
        setOverrideErr('Failed to disconnect Owner Override.');
      } else {
        setCodeSent(false);
        setAwaitingPassword(false);
        setOverrideMsg('Owner Override disconnected.');
        await onRefreshState();
      }
    } catch {
      setOverrideErr('Network error disconnecting Owner Override.');
    } finally {
      setOverrideBusy(false);
    }
  };

  const handleEnableWebhook = async (e: FormEvent) => {
    e.preventDefault();
    setHostingMsg(null);
    setHostingErr(null);
    if (!webhookInput.trim()) {
      setHostingErr('Enter your public deployed HTTPS URL (e.g. https://ca-rose-bot.onrender.com).');
      return;
    }

    setHostingBusy(true);
    try {
      const res = await fetch('/api/telegram/hosting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'enable-webhook',
          webhookUrl: webhookInput.trim(),
        }),
      });
      const data = (await res.json()) as {
        message?: string;
        error?: string;
        status?: TelegramBridgeStatus;
      };
      if (!res.ok) {
        setHostingErr(data.error || 'Could not enable 24/7 Webhook mode.');
      } else {
        setHostingMsg(data.message || '24/7 Webhook enabled cleanly.');
        await onRefreshState();
      }
    } catch {
      setHostingErr('Network error verifying public webhook URL.');
    } finally {
      setHostingBusy(false);
    }
  };

  const handleSwitchToPolling = async () => {
    setHostingMsg(null);
    setHostingErr(null);
    setHostingBusy(true);
    try {
      const res = await fetch('/api/telegram/hosting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'enable-polling' }),
      });
      const data = (await res.json()) as { message?: string; error?: string };
      if (!res.ok) {
        setHostingErr(data.error || 'Could not switch back to Live Polling.');
      } else {
        setHostingMsg(data.message || 'Switched back to Live Polling.');
        await onRefreshState();
      }
    } catch {
      setHostingErr('Network error switching hosting mode.');
    } finally {
      setHostingBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Member Roster + /info Inspector */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        <section
          aria-label="Group Member Roster"
          className={`${
            inspectedMember ? 'xl:col-span-9' : 'xl:col-span-12'
          } bg-white border border-slate-200 rounded-xl overflow-hidden`}
        >
          <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Member Roster & Moderation</h2>
              <p className="text-xs text-slate-500 tabular-nums">
                {members.length} tracked accounts in SQLite
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="search"
                  aria-label="Search members by name, username, or ID"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search name, @user, ID..."
                  className="text-xs pl-8 pr-3 py-1.5 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg" role="group" aria-label="Filter members by status">
                {(['all', 'active', 'muted', 'banned', 'warned'] as MemberFilter[]).map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setFilter(key)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md capitalize transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      filter === key
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {key}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {(actionMsg || actionErr) && (
            <div
              className={`px-5 py-2.5 text-xs border-b ${
                actionErr
                  ? 'bg-red-50 text-red-700 border-red-200'
                  : 'bg-blue-50 text-blue-800 border-blue-200'
              }`}
            >
              {actionErr || actionMsg}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                  <th className="py-2.5 px-3">Member</th>
                  {!inspectedMember && <th className="py-2.5 px-3">User ID</th>}
                  <th className="py-2.5 px-3">Role</th>
                  <th className="py-2.5 px-3">Status</th>
                  <th className="py-2.5 px-3 text-right">Warns</th>
                  <th className="py-2.5 px-3 text-right">Msgs</th>
                  <th className="py-2.5 px-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {filteredMembers.length === 0 ? (
                  <tr>
                    <td colSpan={inspectedMember ? 6 : 7} className="py-10 text-center text-slate-500">
                      No members match your current filter.
                    </td>
                  </tr>
                ) : (
                  filteredMembers.map((m) => {
                    const statusLabel = !m.is_active
                      ? 'Banned'
                      : m.is_muted
                        ? 'Muted'
                        : 'Active';
                    const statusColor = !m.is_active
                      ? 'text-red-700'
                      : m.is_muted
                        ? 'text-amber-700'
                        : 'text-emerald-700';

                    return (
                      <tr key={m.user_id} className="hover:bg-slate-50/80 transition-colors">
                        <td className="py-2.5 px-3">
                          <div className="flex items-center gap-2.5">
                            <Avatar
                              src={m.avatar_url}
                              name={m.full_name}
                              sizeClass="h-8 w-8"
                              isBot={m.is_bot}
                            />
                            <div className="min-w-0">
                              <div className="font-medium text-slate-900 truncate">{m.full_name}</div>
                              <div className="font-mono text-slate-500 truncate">
                                {m.username ? `@${m.username}` : 'No username'}
                              </div>
                            </div>
                          </div>
                        </td>
                        {!inspectedMember && (
                          <td className="py-2.5 px-3 font-mono tabular-nums text-slate-600">
                            {m.user_id}
                          </td>
                        )}
                        <td className="py-2.5 px-3 capitalize text-slate-700">{m.role}</td>
                        <td className={`py-2.5 px-3 font-medium ${statusColor}`}>{statusLabel}</td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-700">
                          {m.warns}/{settings.max_warns}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-700">
                          {m.msg_count}
                        </td>
                        <td className="py-2.5 px-3">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => onSelectInspect(m)}
                              className="inline-flex items-center gap-1 px-2 py-1 text-slate-700 hover:text-blue-700 bg-slate-100 hover:bg-blue-50 rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                            >
                              <Info className="w-3 h-3" />
                              Info
                            </button>
                            {!m.is_bot && m.role === 'administrator' && (
                              <button
                                type="button"
                                aria-label={`Demote ${m.full_name}`}
                                onClick={() => void runModAction(m.user_id, 'demote')}
                                className="px-2 py-1 text-slate-700 bg-slate-100 hover:bg-slate-200 rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                              >
                                Demote
                              </button>
                            )}
                            {!m.is_bot && m.role === 'member' && (
                              <>
                                <button
                                  type="button"
                                  aria-label={`Promote ${m.full_name}`}
                                  onClick={() => void runModAction(m.user_id, 'promote')}
                                  className="px-2 py-1 text-blue-700 bg-blue-50 hover:bg-blue-100 rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                                >
                                  Promote
                                </button>
                                <button
                                  type="button"
                                  aria-label={`Warn ${m.full_name}`}
                                  onClick={() => void runModAction(m.user_id, 'warn')}
                                  className="px-2 py-1 text-amber-800 bg-amber-50 hover:bg-amber-100 rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                                >
                                  Warn
                                </button>
                                <button
                                  type="button"
                                  aria-label={`${m.is_muted ? 'Unmute' : 'Mute'} ${m.full_name}`}
                                  onClick={() =>
                                    void runModAction(m.user_id, m.is_muted ? 'unmute' : 'mute')
                                  }
                                  className="px-2 py-1 text-slate-700 bg-slate-100 hover:bg-slate-200 rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                                >
                                  {m.is_muted ? 'Unmute' : 'Mute'}
                                </button>
                                <button
                                  type="button"
                                  aria-label={`${m.is_active ? 'Ban' : 'Unban'} ${m.full_name}`}
                                  onClick={() =>
                                    void runModAction(m.user_id, m.is_active ? 'ban' : 'unban')
                                  }
                                  className={`px-2 py-1 rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                                    m.is_active
                                      ? 'text-red-700 bg-red-50 hover:bg-red-100'
                                      : 'text-emerald-700 bg-emerald-50 hover:bg-emerald-100'
                                  }`}
                                >
                                  {m.is_active ? 'Ban' : 'Unban'}
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Admin /info Member Inspector Drawer */}
        {inspectedMember && (
          <aside
            aria-label="Member Info Inspector"
            className="xl:col-span-3 bg-white border border-slate-200 rounded-xl p-5 space-y-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <Avatar
                  src={inspectedMember.avatar_url}
                  name={inspectedMember.full_name}
                  sizeClass="h-11 w-11"
                  isBot={inspectedMember.is_bot}
                />
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-slate-900 truncate">
                    {inspectedMember.full_name}
                  </h3>
                  <p className="text-xs font-mono text-slate-500 truncate">
                    {inspectedMember.username ? `@${inspectedMember.username}` : 'No username'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                aria-label="Close member info inspector"
                onClick={() => onSelectInspect(null)}
                className="text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <dl className="divide-y divide-slate-100 text-xs">
              <div className="py-2 flex justify-between gap-3">
                <dt className="text-slate-500">User ID</dt>
                <dd className="font-mono tabular-nums text-slate-900">{inspectedMember.user_id}</dd>
              </div>
              <div className="py-2 flex justify-between gap-3">
                <dt className="text-slate-500">Group Role</dt>
                <dd className="capitalize font-medium text-slate-900">{inspectedMember.role}</dd>
              </div>
              <div className="py-2 flex justify-between gap-3">
                <dt className="text-slate-500">Is Bot</dt>
                <dd className="text-slate-900">{inspectedMember.is_bot ? 'Yes' : 'No'}</dd>
              </div>
              <div className="py-2 flex justify-between gap-3">
                <dt className="text-slate-500">Warnings</dt>
                <dd className="font-mono tabular-nums text-slate-900">
                  {inspectedMember.warns}/{settings.max_warns}
                </dd>
              </div>
              <div className="py-2 flex justify-between gap-3">
                <dt className="text-slate-500">Tracked Messages</dt>
                <dd className="font-mono tabular-nums text-slate-900">{inspectedMember.msg_count}</dd>
              </div>
              <div className="py-2 flex justify-between gap-3">
                <dt className="text-slate-500">First Seen</dt>
                <dd className="font-mono tabular-nums text-slate-700">{inspectedMember.first_seen}</dd>
              </div>
              <div className="py-2 flex justify-between gap-3">
                <dt className="text-slate-500">Last Seen</dt>
                <dd className="font-mono tabular-nums text-slate-700">{inspectedMember.last_seen}</dd>
              </div>
            </dl>

            {!inspectedMember.is_bot && inspectedMember.role !== 'owner' && (
              <div className="pt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() =>
                    void runModAction(
                      inspectedMember.user_id,
                      inspectedMember.role === 'administrator' ? 'demote' : 'promote'
                    )
                  }
                  className="px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg cursor-pointer"
                >
                  {inspectedMember.role === 'administrator' ? 'Demote' : 'Promote'}
                </button>
                {inspectedMember.role === 'member' && (
                  <>
                    <button
                      type="button"
                      onClick={() => void runModAction(inspectedMember.user_id, 'resetwarns')}
                      className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                    >
                      Reset Warns
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void runModAction(
                          inspectedMember.user_id,
                          inspectedMember.is_active ? 'kick' : 'unban'
                        )
                      }
                      className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                    >
                      {inspectedMember.is_active ? 'Kick' : 'Restore'}
                    </button>
                  </>
                )}
              </div>
            )}
          </aside>
        )}
      </div>

      {/* Group Settings: Welcome & Rules */}
      <section
        aria-label="Group Welcome and Rules Settings"
        className="bg-white border border-slate-200 rounded-xl p-6 space-y-5"
      >
        <div className="flex items-center justify-between gap-4 border-b border-slate-100 pb-4">
          <div className="flex items-center gap-2">
            <Settings2 className="w-4 h-4 text-blue-700 shrink-0" />
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Welcome, Rules & Warn Threshold</h2>
              <p className="text-xs text-slate-500">
                Mirrors /setwelcome, /welcome on|off, /setrules, and SQLite max_warns
              </p>
            </div>
          </div>

          {settingsSavedMsg && (
            <span className="text-xs font-medium text-emerald-700">{settingsSavedMsg}</span>
          )}
        </div>

        <form onSubmit={(e) => void handleSaveSettings(e)} className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div className="space-y-1.5">
            <label htmlFor="group-title-input" className="block text-xs font-medium text-slate-700">
              Group Title
            </label>
            <input
              id="group-title-input"
              type="text"
              value={chatTitle}
              onChange={(e) => setChatTitle(e.target.value)}
              className="w-full text-sm px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="max-warns-input" className="block text-xs font-medium text-slate-700">
              Max Warnings Before Auto-Ban
            </label>
            <div className="flex items-center gap-4">
              <input
                id="max-warns-input"
                type="number"
                min={1}
                max={10}
                value={maxWarns}
                onChange={(e) => setMaxWarns(Number(e.target.value))}
                className="w-24 text-sm font-mono tabular-nums px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
              <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={welcomeEnabled}
                  onChange={(e) => setWelcomeEnabled(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-blue-700 focus:ring-blue-600"
                />
                Enable Welcome Message on Join
              </label>
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="welcome-template-input" className="block text-xs font-medium text-slate-700">
              Welcome Template ({'{mention}'}, {'{name}'}, {'{chat_title}'})
            </label>
            <textarea
              id="welcome-template-input"
              rows={3}
              value={welcomeText}
              onChange={(e) => setWelcomeText(e.target.value)}
              className="w-full text-sm px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="rules-text-input" className="block text-xs font-medium text-slate-700">
              Group Rules (/rules)
            </label>
            <textarea
              id="rules-text-input"
              rows={3}
              value={rulesText}
              onChange={(e) => setRulesText(e.target.value)}
              className="w-full text-sm px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          </div>

          <div className="md:col-span-2 flex items-center justify-between pt-1">
            <div className="flex items-center gap-1.5 text-xs text-slate-500">
              <ShieldAlert className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <span>Changes persist immediately in SQLite and apply to /rules & member joins.</span>
            </div>
            <button
              type="submit"
              disabled={savingSettings}
              className="px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              {savingSettings ? 'Saving...' : 'Save Settings'}
            </button>
          </div>
        </form>
      </section>

      {/* Owner MTProto Override: Demote / Promote Old Owner-Promoted Admins */}
      <section
        aria-label="Telegram Owner Override Settings"
        className="bg-white border border-slate-200 rounded-xl p-6 space-y-5"
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 pb-4">
          <div className="flex items-start gap-2.5 flex-1 min-w-0">
            <KeyRound className="w-4 h-4 text-blue-700 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-slate-900">
                Owner Override (Demote &amp; Edit Old Admins)
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Telegram blocks Bot API tokens from demoting admins originally promoted by the Group Owner (
                <code className="font-mono">can_be_edited: false</code>). Link the Group Owner&apos;s Telegram session once so <code className="font-mono">/demote</code> &amp; <code className="font-mono">/promote</code> work on all admins.
              </p>
            </div>
          </div>

          <span
            className={`text-xs font-medium whitespace-nowrap shrink-0 ${
              ownerOverride?.connected ? 'text-emerald-700' : 'text-slate-600'
            }`}
          >
            {ownerOverride?.connected
              ? `Connected: ${ownerOverride.accountLabel || ownerOverride.userId}`
              : 'Not connected'}
          </span>
        </div>

        {(overrideMsg || overrideErr || ownerOverride?.lastError) && (
          <div
            role={overrideErr ? 'alert' : undefined}
            className={`px-4 py-2.5 text-xs rounded-lg border ${
              overrideErr || (!ownerOverride?.connected && ownerOverride?.lastError)
                ? 'bg-red-50 text-red-700 border-red-200'
                : 'bg-emerald-50 text-emerald-800 border-emerald-200'
            }`}
          >
            {overrideErr || overrideMsg || ownerOverride?.lastError}
          </div>
        )}

        {ownerOverride?.connected ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-4 p-4 bg-emerald-50/60 border border-emerald-200 rounded-lg">
              <div className="flex items-center gap-3">
                <ShieldCheck className="w-5 h-5 text-emerald-700 shrink-0" />
                <div className="text-xs">
                  <div className="font-semibold text-slate-900">
                    Owner Override Active ({ownerOverride.accountLabel || ownerOverride.userId})
                  </div>
                  <div className="text-slate-600 mt-0.5">
                    Any <code className="font-mono">/demote</code> or <code className="font-mono">/promote</code> targeting an Owner-promoted admin executes with Group Owner MTProto rights.
                  </div>
                </div>
              </div>
              <button
                type="button"
                disabled={overrideBusy}
                onClick={() => void handleDisconnectOwner()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-700 bg-white border border-red-200 hover:bg-red-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
              >
                <Unplug className="w-3.5 h-3.5" />
                Disconnect Owner
              </button>
            </div>

            {(ownerOverride.freshCooldownRemaining ||
              (ownerOverride.lastError ?? '').toUpperCase().includes('FRESH_CHANGE_ADMINS_FORBIDDEN')) && (
              <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900 space-y-1">
                <div className="font-semibold">
                  Telegram 24h New-Session Cooldown Active
                  {ownerOverride.freshCooldownRemaining
                    ? ` (~${ownerOverride.freshCooldownRemaining} remaining)`
                    : ''}
                </div>
                <p className="leading-relaxed">
                  Your Owner session is saved and connected, but Telegram blocks newly created sessions from modifying old admins for 24 hours (<code className="font-mono">FRESH_CHANGE_ADMINS_FORBIDDEN</code>).
                  {' '}<strong>Do not click Disconnect or re-login</strong> (re-logging in resets the 24h timer). For today, demote old admins once via Telegram&apos;s Group Settings → Administrators.
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg w-fit" role="tablist" aria-label="Owner connection method">
              <button
                type="button"
                role="tab"
                aria-selected={overrideMode === 'login'}
                onClick={() => setOverrideMode('login')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                  overrideMode === 'login' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Telegram Login (Phone + Code)
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={overrideMode === 'session'}
                onClick={() => setOverrideMode('session')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                  overrideMode === 'session' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Paste Session String
              </button>
            </div>

            {overrideMode === 'login' ? (
              !codeSent ? (
                <form onSubmit={(e) => void handleSendOwnerCode(e)} className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="space-y-1.5">
                    <label htmlFor="owner-api-id" className="block text-xs font-medium text-slate-700">
                      Telegram API ID (from my.telegram.org)
                    </label>
                    <input
                      id="owner-api-id"
                      type="text"
                      inputMode="numeric"
                      value={apiIdInput}
                      onChange={(e) => setApiIdInput(e.target.value)}
                      placeholder="e.g. 12345678"
                      className="w-full text-sm font-mono px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="owner-api-hash" className="block text-xs font-medium text-slate-700">
                      Telegram API Hash
                    </label>
                    <input
                      id="owner-api-hash"
                      type="password"
                      value={apiHashInput}
                      onChange={(e) => setApiHashInput(e.target.value)}
                      placeholder="32-character api_hash"
                      className="w-full text-sm font-mono px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="owner-phone" className="block text-xs font-medium text-slate-700">
                      Owner Phone Number
                    </label>
                    <input
                      id="owner-phone"
                      type="tel"
                      value={phoneInput}
                      onChange={(e) => setPhoneInput(e.target.value)}
                      placeholder="e.g. +919876543210"
                      className="w-full text-sm font-mono px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>
                  <div className="md:col-span-3 flex items-center justify-between gap-4">
                    <span className="text-xs text-slate-500">
                      Get API ID &amp; API Hash from my.telegram.org → API development tools. Stored locally in SQLite.
                    </span>
                    <button
                      type="submit"
                      disabled={overrideBusy}
                      className="px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                    >
                      {overrideBusy ? 'Sending Code...' : 'Send Telegram Code'}
                    </button>
                  </div>
                </form>
              ) : (
                <form onSubmit={(e) => void handleVerifyOwnerCode(e)} className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label htmlFor="owner-phone-code" className="block text-xs font-medium text-slate-700">
                      Telegram Login Code
                    </label>
                    <input
                      id="owner-phone-code"
                      type="text"
                      value={phoneCodeInput}
                      onChange={(e) => setPhoneCodeInput(e.target.value)}
                      placeholder="e.g. 54321"
                      className="w-full text-sm font-mono px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="owner-2fa-password" className="block text-xs font-medium text-slate-700">
                      2FA Cloud Password {awaitingPassword ? '(Required)' : '(If enabled)'}
                    </label>
                    <input
                      id="owner-2fa-password"
                      type="password"
                      value={passwordInput}
                      onChange={(e) => setPasswordInput(e.target.value)}
                      placeholder="Optional unless 2FA is active"
                      className="w-full text-sm px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>
                  <div className="md:col-span-2 flex items-center justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        setCodeSent(false);
                        setAwaitingPassword(false);
                      }}
                      className="px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                    >
                      Use Different Number
                    </button>
                    <button
                      type="submit"
                      disabled={overrideBusy}
                      className="px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                    >
                      {overrideBusy ? 'Verifying...' : 'Verify & Connect Owner'}
                    </button>
                  </div>
                </form>
              )
            ) : (
              <form onSubmit={(e) => void handleConnectSessionString(e)} className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label htmlFor="session-api-id" className="block text-xs font-medium text-slate-700">
                    Telegram API ID
                  </label>
                  <input
                    id="session-api-id"
                    type="text"
                    inputMode="numeric"
                    value={apiIdInput}
                    onChange={(e) => setApiIdInput(e.target.value)}
                    placeholder="e.g. 12345678"
                    className="w-full text-sm font-mono px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="session-api-hash" className="block text-xs font-medium text-slate-700">
                    Telegram API Hash
                  </label>
                  <input
                    id="session-api-hash"
                    type="password"
                    value={apiHashInput}
                    onChange={(e) => setApiHashInput(e.target.value)}
                    placeholder="32-character api_hash"
                    className="w-full text-sm font-mono px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
                <div className="md:col-span-2 space-y-1.5">
                  <label htmlFor="owner-session-string" className="block text-xs font-medium text-slate-700">
                    GramJS OWNER_SESSION_STRING
                  </label>
                  <textarea
                    id="owner-session-string"
                    rows={2}
                    value={sessionStringInput}
                    onChange={(e) => setSessionStringInput(e.target.value)}
                    placeholder="Paste GramJS StringSession for the Group Owner account"
                    className="w-full text-xs font-mono px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
                <div className="md:col-span-2 flex justify-end">
                  <button
                    type="submit"
                    disabled={overrideBusy}
                    className="px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                  >
                    {overrideBusy ? 'Connecting...' : 'Connect Session String'}
                  </button>
                </div>
              </form>
            )}
          </div>
        )}
      </section>

      {/* 24/7 Always-On Hosting & Webhook */}
      <section
        aria-label="24/7 Always-On Hosting and Webhook"
        className="bg-white border border-slate-200 rounded-xl p-6 space-y-5"
      >
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-4">
          <div className="flex items-start gap-2.5 flex-1 min-w-0">
            <Cloud className="w-4 h-4 text-blue-700 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-slate-900">
                24/7 Always-On Hosting &amp; Webhook
              </h2>
              <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">
                Google AI Studio&apos;s temporary preview (<code className="font-mono">ais-dev-*</code>) sleeps automatically when closed, so polling stops until you reopen the workspace. Keep the bot running 24/7 with either option below.
              </p>
            </div>
          </div>

          <span
            className={`text-xs font-medium px-2.5 py-1 rounded-md whitespace-nowrap shrink-0 ${
              telegram?.mode === 'webhook'
                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                : telegram?.running
                  ? 'bg-blue-50 text-blue-700 border border-blue-200'
                  : 'bg-slate-100 text-slate-600'
            }`}
          >
            {telegram?.mode === 'webhook'
              ? '24/7 Webhook Active'
              : telegram?.running
                ? 'Live Polling (AI Studio Open)'
                : 'Stopped'}
          </span>
        </div>

        {(hostingMsg || hostingErr) && (
          <div
            role={hostingErr ? 'alert' : undefined}
            className={`px-4 py-2.5 text-xs rounded-lg border ${
              hostingErr
                ? 'bg-red-50 text-red-700 border-red-200'
                : 'bg-emerald-50 text-emerald-800 border-emerald-200'
            }`}
          >
            {hostingErr || hostingMsg}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          <div className="lg:col-span-5 p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
            <div className="text-xs font-semibold text-slate-900">
              Option A — Standalone 24/7 Python Bot (Recommended)
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              Export the self-contained Python + SQLite bot bundle (<code className="font-mono">Dockerfile</code>, <code className="font-mono">render.yaml</code>, <code className="font-mono">Procfile</code>) and deploy it on Render, Koyeb, Railway, Fly.io, or a VPS. Once deployed, your bot answers Telegram 24/7 even when Google AI Studio is completely closed.
            </p>
            {onOpenPythonSource && (
              <button
                type="button"
                onClick={onOpenPythonSource}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
              >
                Open Python Source &amp; Download ZIP
              </button>
            )}
          </div>

          <form
            onSubmit={(e) => void handleEnableWebhook(e)}
            className="lg:col-span-7 p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-semibold text-slate-900">
                Option B — Switch Full-Stack App to 24/7 Webhook Mode
              </div>
              {telegram?.mode === 'webhook' && (
                <button
                  type="button"
                  disabled={hostingBusy}
                  onClick={() => void handleSwitchToPolling()}
                  className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 rounded-md cursor-pointer disabled:opacity-50"
                >
                  Switch Back to Polling
                </button>
              )}
            </div>

            <p className="text-xs text-slate-600 leading-relaxed">
              When you deploy this full-stack app to a public unauthenticated HTTPS host (e.g., public Cloud Run / Render / Railway), paste its base URL below. Telegram will push updates directly to <code className="font-mono">/api/telegram/webhook</code> and wake the server on demand.
            </p>

            {telegram?.webhookUrl && (
              <div className="text-xs font-mono text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 break-all">
                Active Webhook: {telegram.webhookUrl}
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="url"
                aria-label="Public deployed HTTPS base URL"
                value={webhookInput}
                onChange={(e) => setWebhookInput(e.target.value)}
                placeholder="https://your-public-app.onrender.com"
                className="flex-1 text-xs font-mono px-3 py-2 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
              <button
                type="submit"
                disabled={hostingBusy}
                className="px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
              >
                {hostingBusy ? 'Verifying Probe...' : 'Verify & Enable Webhook'}
              </button>
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}

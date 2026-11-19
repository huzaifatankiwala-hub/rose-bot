import { useCallback, useEffect, useState } from 'react';
import {
  Code2,
  GraduationCap,
  Menu,
  MessageSquareText,
  RotateCcw,
  Users,
  X,
} from 'lucide-react';
import { Avatar } from './components/Avatar';
import { CaGuiderView } from './components/CaGuiderView';
import { GroupSimulatorView } from './components/GroupSimulatorView';
import { MembersSettingsView } from './components/MembersSettingsView';
import { PythonSourceView } from './components/PythonSourceView';
import type { AppStateResponse, GroupMember } from './types';

type ActiveTab = 'simulator' | 'ca-guider' | 'members' | 'python';

const NAV_ITEMS: Array<{
  id: ActiveTab;
  label: string;
  title: string;
  icon: typeof MessageSquareText;
}> = [
  {
    id: 'simulator',
    label: 'Group Simulator',
    title: 'Telegram Group & Command Simulator',
    icon: MessageSquareText,
  },
  {
    id: 'ca-guider',
    label: 'CA Study Guider',
    title: 'CA-Specialized Gemini AI Guider',
    icon: GraduationCap,
  },
  {
    id: 'members',
    label: 'Members & Settings',
    title: 'Member Roster, /info & Group Rules',
    icon: Users,
  },
  {
    id: 'python',
    label: 'Python Source',
    title: 'Python Bot Bundle & BotFather Setup',
    icon: Code2,
  },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('simulator');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [appState, setAppState] = useState<AppStateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeSenderId, setActiveSenderId] = useState<number>(1001001);
  const [inspectedMember, setInspectedMember] = useState<GroupMember | null>(null);
  const [resetting, setResetting] = useState(false);

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch('/api/state');
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as AppStateResponse;
      setAppState(data);
      setLoadError(null);

      // Keep activeSenderId valid & active if possible
      const activeHumans = data.members.filter((m) => !m.is_bot && m.is_active);
      if (activeHumans.length > 0 && !activeHumans.some((m) => m.user_id === activeSenderId)) {
        setActiveSenderId(activeHumans[0].user_id);
      }
    } catch {
      setLoadError('Unable to load bot workspace state.');
    } finally {
      setLoading(false);
    }
  }, [activeSenderId]);

  useEffect(() => {
    void fetchState();
  }, [fetchState]);

  const handleResetDemo = async () => {
    setResetting(true);
    try {
      await fetch('/api/reset', { method: 'POST' });
      setInspectedMember(null);
      setActiveSenderId(1001001);
      await fetchState();
    } finally {
      setResetting(false);
    }
  };

  const handleInspectFromChat = (member: GroupMember) => {
    setInspectedMember(member);
    setActiveTab('members');
  };

  const activeNav = NAV_ITEMS.find((item) => item.id === activeTab) ?? NAV_ITEMS[0];
  const activeMembersCount = appState
    ? appState.members.filter((m) => m.is_active && !m.is_bot).length
    : 0;
  const totalWarnsCount = appState
    ? appState.members.reduce((sum, m) => sum + m.warns, 0)
    : 0;
  const totalMsgCount = appState
    ? appState.members.reduce((sum, m) => sum + m.msg_count, 0)
    : 0;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col lg:flex-row">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:shrink-0 bg-white border-r border-slate-200">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-3">
          <Avatar
            src="/src/assets/images/avatar_ca_bot_1794835035532.jpg"
            name="CA Rose Bot"
            sizeClass="h-9 w-9"
            isBot
          />
          <div className="min-w-0">
            <div className="text-sm font-bold font-display text-slate-900 truncate">
              CA Rose Studio
            </div>
            <div className="text-xs font-mono text-slate-500 truncate">@CA_Rose_Bot</div>
          </div>
        </div>

        <nav aria-label="Primary navigation" className="flex-1 p-3 space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
                  isActive
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100/70'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-200 space-y-1.5 text-xs text-slate-600">
          <div className="font-medium text-slate-900">Telegram Bridge</div>
          {appState?.telegram.running ? (
            <>
              <p className="font-mono text-slate-800">@{appState.telegram.botUsername}</p>
              <p className="leading-relaxed">
                Mode:{' '}
                <span
                  className={
                    appState.telegram.mode === 'webhook'
                      ? 'font-semibold text-emerald-700'
                      : 'font-semibold text-blue-700'
                  }
                >
                  {appState.telegram.mode === 'webhook'
                    ? '24/7 Webhook'
                    : 'Live Polling (Active while workspace open)'}
                </span>
              </p>
              <p className="leading-relaxed">
                Group Privacy:{' '}
                <span
                  className={
                    appState.telegram.canReadAllGroupMessages === false
                      ? 'font-semibold text-amber-700'
                      : 'font-semibold text-emerald-700'
                  }
                >
                  {appState.telegram.canReadAllGroupMessages === false
                    ? 'ON (Turn OFF in @BotFather or make Admin)'
                    : 'OFF (Ready)'}
                </span>
              </p>
              <p className="leading-relaxed">
                Owner Override:{' '}
                <span
                  className={
                    appState.telegram.ownerOverride?.connected
                      ? 'font-semibold text-emerald-700'
                      : 'font-semibold text-slate-600'
                  }
                >
                  {appState.telegram.ownerOverride?.connected
                    ? `Active (${appState.telegram.ownerOverride.accountLabel || 'Connected'})`
                    : 'Not linked'}
                </span>
              </p>
              {appState.telegram.lastError && (
                <p className="text-red-700 break-words">{appState.telegram.lastError}</p>
              )}
              {appState.telegram.lastEvent && !appState.telegram.lastError && (
                <p className="text-slate-500 break-words">{appState.telegram.lastEvent}</p>
              )}
            </>
          ) : (
            <p className="leading-relaxed">
              {appState?.telegram.configured
                ? appState.telegram.lastError || 'Configured, waiting to connect.'
                : 'Simulator active. Set TELEGRAM_BOT_TOKEN in Secrets for live Telegram polling.'}
            </p>
          )}
        </div>
      </aside>

      {/* Mobile Navigation Drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-40 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/40"
            onClick={() => setMobileNavOpen(false)}
          />
          <div className="relative z-50 w-64 max-w-[80vw] bg-white h-full border-r border-slate-200 flex flex-col">
            <div className="px-4 py-3.5 border-b border-slate-200 flex items-center justify-between">
              <span className="text-sm font-bold font-display text-slate-900">CA Rose Studio</span>
              <button
                type="button"
                aria-label="Close navigation menu"
                onClick={() => setMobileNavOpen(false)}
                className="p-1 text-slate-500 hover:text-slate-900 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <nav aria-label="Mobile navigation" className="p-3 space-y-1">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const isActive = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveTab(item.id);
                      setMobileNavOpen(false);
                    }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-sm font-medium rounded-lg whitespace-nowrap cursor-pointer ${
                      isActive
                        ? 'bg-blue-50 text-blue-700'
                        : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Bar Contract: Breadcrumb/Title on left, 1 primary action on right */}
        <header className="bg-white border-b border-slate-200 px-4 sm:px-6 py-3.5 flex items-center justify-between gap-8">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              aria-label="Open navigation menu"
              onClick={() => setMobileNavOpen(true)}
              className="lg:hidden p-2 -ml-2 text-slate-600 hover:text-slate-900 rounded-lg hover:bg-slate-100 cursor-pointer shrink-0"
            >
              <Menu className="w-4 h-4" />
            </button>
            <div className="flex items-center gap-2 text-sm min-w-0">
              <span className="hidden sm:inline text-slate-400 whitespace-nowrap">
                CA Rose Studio
              </span>
              <span className="hidden sm:inline text-slate-300" aria-hidden="true">
                /
              </span>
              <h1 className="font-semibold text-slate-900 truncate">{activeNav.title}</h1>
            </div>
          </div>

          <button
            type="button"
            disabled={resetting}
            onClick={() => void handleResetDemo()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            {resetting ? 'Resetting...' : 'Reset Demo'}
          </button>
        </header>

        {/* Compact Metrics Strip */}
        {appState && (
          <div className="bg-white border-b border-slate-200 px-4 sm:px-6 py-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 divide-x-0 sm:divide-x divide-slate-200">
              <div className="sm:pr-4">
                <div className="text-xs text-slate-500">Active Members</div>
                <div className="text-base font-semibold font-mono tabular-nums text-slate-900">
                  {activeMembersCount}
                </div>
              </div>
              <div className="sm:px-4">
                <div className="text-xs text-slate-500">Tracked Messages</div>
                <div className="text-base font-semibold font-mono tabular-nums text-slate-900">
                  {totalMsgCount}
                </div>
              </div>
              <div className="sm:px-4">
                <div className="text-xs text-slate-500">Active Warnings</div>
                <div className="text-base font-semibold font-mono tabular-nums text-slate-900">
                  {totalWarnsCount}
                </div>
              </div>
              <div className="sm:pl-4">
                <div className="text-xs text-slate-500">Welcome Automation</div>
                <div className="text-base font-semibold text-slate-900">
                  {appState.settings.welcome_enabled ? 'Enabled' : 'Disabled'}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Workspace Viewport */}
        <main className="flex-1 p-4 sm:p-6 max-w-[1440px] w-full mx-auto">
          {loading && (
            <div className="bg-white border border-slate-200 rounded-xl p-8 text-sm text-slate-500">
              Loading SQLite group workspace...
            </div>
          )}

          {!loading && loadError && (
            <div role="alert" className="bg-red-50 border border-red-200 rounded-xl p-6 text-sm text-red-700">
              {loadError}
            </div>
          )}

          {!loading && appState && (
            <>
              {activeTab === 'simulator' && (
                <GroupSimulatorView
                  settings={appState.settings}
                  members={appState.members}
                  messages={appState.messages}
                  pinnedMessage={appState.pinnedMessage}
                  activeSenderId={activeSenderId}
                  onChangeSender={setActiveSenderId}
                  onRefreshState={fetchState}
                  onInspectMember={handleInspectFromChat}
                />
              )}
              {activeTab === 'ca-guider' && <CaGuiderView />}
              {activeTab === 'members' && (
                <MembersSettingsView
                  settings={appState.settings}
                  members={appState.members}
                  activeSenderId={activeSenderId}
                  inspectedMember={inspectedMember}
                  ownerOverride={appState.telegram.ownerOverride}
                  telegram={appState.telegram}
                  onSelectInspect={setInspectedMember}
                  onRefreshState={fetchState}
                  onOpenPythonSource={() => setActiveTab('python')}
                />
              )}
              {activeTab === 'python' && <PythonSourceView />}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

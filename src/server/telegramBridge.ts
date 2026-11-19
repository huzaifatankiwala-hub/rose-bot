import crypto from 'node:crypto';
import {
  CA_ONE_TIME_NOTICE,
  SYSTEM_TG_ACCOUNT_IDS,
  buildTagAllChunks,
  chunkTelegramText,
  escapeHtml,
  evaluateBotAdminPermissions,
  evaluatePromoteBotRights,
  extractMuteMinutes,
  formatBotGroupAddedGreeting,
  formatTelegramModErrorHtml,
  isBotMentionedOrReplied,
  isCasualAckOrGreeting,
  isNonCaSentinelOrRefusal,
  isTelegramAdminLockError,
  isTransientTimeoutOrNetworkError,
  normalizeWebhookBaseUrl,
  parseCommand,
  renderWelcomeMessage,
  resolveTargetWithArgs,
  stripBotMention,
  validateModerationTarget,
  withTimeout,
  type BotPermissionKey,
  type ModerationAction,
} from '../lib/botLogic';
import type { GroupMember, MemberRole, TelegramBridgeStatus } from '../types';
import { botDb } from './db';
import { ownerMtproto } from './ownerMtproto';
import { askGeminiCA, fetchWeatherForCity } from './services';

interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
}

interface TgChatPermissions {
  can_send_messages?: boolean;
  can_send_audios?: boolean;
  can_send_documents?: boolean;
  can_send_photos?: boolean;
  can_send_videos?: boolean;
  can_send_video_notes?: boolean;
  can_send_voice_notes?: boolean;
  can_send_polls?: boolean;
  can_send_other_messages?: boolean;
  can_add_web_page_previews?: boolean;
}

interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  permissions?: TgChatPermissions;
}

interface TgChatMember {
  status: 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked';
  user: TgUser;
  can_be_edited?: boolean;
  can_manage_chat?: boolean;
  can_delete_messages?: boolean;
  can_manage_video_chats?: boolean;
  can_restrict_members?: boolean;
  can_promote_members?: boolean;
  can_change_info?: boolean;
  can_invite_users?: boolean;
  can_pin_messages?: boolean;
  can_manage_topics?: boolean;
}

interface TgMessageEntity {
  type: string;
  offset: number;
  length: number;
  user?: TgUser;
}

interface TgVoiceOrAudio {
  file_id: string;
  mime_type?: string;
  file_size?: number;
}

interface TgMessage {
  message_id: number;
  message_thread_id?: number;
  from?: TgUser;
  sender_chat?: TgChat;
  chat: TgChat;
  text?: string;
  caption?: string;
  entities?: TgMessageEntity[];
  caption_entities?: TgMessageEntity[];
  voice?: TgVoiceOrAudio;
  audio?: TgVoiceOrAudio;
  reply_to_message?: TgMessage;
  forum_topic_created?: unknown;
  forward_from?: TgUser;
  pinned_message?: TgMessage;
  new_chat_members?: TgUser[];
  left_chat_member?: TgUser;
}

interface TgChatMemberUpdated {
  chat: TgChat;
  old_chat_member?: TgChatMember;
  new_chat_member: TgChatMember;
}

interface TgMessageReactionUpdated {
  chat: TgChat;
  user?: TgUser;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  chat_member?: TgChatMemberUpdated;
  my_chat_member?: TgChatMemberUpdated;
  message_reaction?: TgMessageReactionUpdated;
}

function mapTgStatusToRole(status: TgChatMember['status']): MemberRole {
  if (status === 'creator') return 'owner';
  if (status === 'administrator') return 'administrator';
  return 'member';
}

function formatFullName(user: TgUser): string {
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || 'User';
}

function mentionHtml(userId: number, name: string): string {
  return `<a href="tg://user?id=${userId}">${escapeHtml(name || 'User')}</a>`;
}

export class TelegramBridge {
  private token: string;
  private running = false;
  private mode: 'polling' | 'webhook' | 'stopped' = 'stopped';
  private webhookUrl: string | null = null;
  private offset = 0;
  private botId = 0;
  private botUsername = '';
  private botFirstName = '';
  private canReadAllGroupMessages: boolean | null = null;
  private updatesProcessed = 0;
  private lastEvent: string | null = null;
  private lastError: string | null = null;
  private recentWelcomeKeys = new Map<string, number>();
  private pollGeneration = 0;
  private lastPollBeatAt = 0;
  private consecutivePollErrors = 0;
  private startingPromise: Promise<void> | null = null;
  private identityPromise: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private chatQueues = new Map<number, Promise<void>>();

  constructor(token: string) {
    this.token = token.trim();
  }

  public getWebhookSecret(): string {
    const explicit = process.env.TELEGRAM_WEBHOOK_SECRET?.trim().replace(/[^A-Za-z0-9_-]/g, '');
    if (explicit && explicit.length >= 8) {
      return explicit.slice(0, 128);
    }
    return crypto
      .createHmac('sha256', this.token || 'ca-rose-bot')
      .update('telegram-webhook-secret')
      .digest('hex')
      .slice(0, 32);
  }

  public verifyWebhookSecret(headerVal?: string | null): boolean {
    if (!this.token) return false;
    const expected = this.getWebhookSecret();
    return Boolean(headerVal && headerVal === expected);
  }

  private shouldSendWelcomeOnce(chatId: number, userId: number): boolean {
    const now = Date.now();
    for (const [k, ts] of this.recentWelcomeKeys.entries()) {
      if (now - ts > 15000) {
        this.recentWelcomeKeys.delete(k);
      }
    }
    const key = `${chatId}:${userId}`;
    if (this.recentWelcomeKeys.has(key)) {
      return false;
    }
    this.recentWelcomeKeys.set(key, now);
    return true;
  }

  public getStatus(): TelegramBridgeStatus {
    return {
      configured: Boolean(this.token),
      running: this.running,
      mode: this.running ? this.mode : 'stopped',
      webhookUrl: this.webhookUrl,
      botUsername: this.botUsername || 'CA_Rose_Bot',
      botFirstName: this.botFirstName || 'CA Rose Guider',
      canReadAllGroupMessages: this.canReadAllGroupMessages,
      updatesProcessed: this.updatesProcessed,
      lastEvent: this.lastEvent,
      lastError: this.lastError,
      ownerOverride: ownerMtproto.getStatus(),
    };
  }

  private async tgCall<T>(method: string, body?: Record<string, unknown>, retryCount = 0): Promise<T> {
    const timeoutMs = method === 'getUpdates' ? 22000 : 15000;
    try {
      const resp = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = (await resp.json()) as {
        ok: boolean;
        result: T;
        description?: string;
        parameters?: { retry_after?: number };
      };
      if (!data.ok) {
        const retryAfter = data.parameters?.retry_after;
        if (retryAfter && retryCount < 2 && method === 'sendMessage') {
          await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
          return this.tgCall<T>(method, body, retryCount + 1);
        }
        throw new Error(data.description || `Telegram API error on ${method}`);
      }
      return data.result;
    } catch (err) {
      if (method !== 'getUpdates' && retryCount < 2 && isTransientTimeoutOrNetworkError(err)) {
        await new Promise((r) => setTimeout(r, 400 * (retryCount + 1)));
        return this.tgCall<T>(method, body, retryCount + 1);
      }
      throw err;
    }
  }

  private async ensureBotIdentity(): Promise<void> {
    if (this.botId > 0) return;
    if (this.identityPromise) return this.identityPromise;
    this.identityPromise = (async () => {
      const me = await this.tgCall<TgUser>('getMe');
      this.botId = me.id;
      this.botUsername = me.username || 'CA_Rose_Bot';
      this.botFirstName = me.first_name || 'CA Rose Guider';
      this.canReadAllGroupMessages =
        typeof me.can_read_all_group_messages === 'boolean'
          ? me.can_read_all_group_messages
          : null;
    })().finally(() => {
      this.identityPromise = null;
    });
    return this.identityPromise;
  }

  private ensureWatchdog(): void {
    if (this.watchdogTimer) {
      return;
    }
    this.watchdogTimer = setInterval(() => {
      if (!this.token || this.mode === 'webhook') {
        return;
      }
      if (!this.running) {
        if (!this.startingPromise) {
          console.warn('[TelegramBridge] Watchdog detected stopped bridge; attempting recovery start...');
          void this.start();
        }
        return;
      }
      if (this.lastPollBeatAt > 0 && Date.now() - this.lastPollBeatAt > 45000) {
        console.warn('[TelegramBridge] Poll loop heartbeat stale (>45s); cycling fresh poll loop...');
        this.pollGeneration += 1;
        this.lastPollBeatAt = Date.now();
        void this.pollLoop(this.pollGeneration);
      }
    }, 30000);
    this.watchdogTimer.unref();
  }

  private enqueueChatTask(chatId: number, task: () => Promise<void>): void {
    const prev = this.chatQueues.get(chatId) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(task)
      .catch((err) => {
        console.error('[TelegramBridge] Queued handler error:', err);
      })
      .finally(() => {
        if (this.chatQueues.get(chatId) === next) {
          this.chatQueues.delete(chatId);
        }
      });
    this.chatQueues.set(chatId, next);
  }

  public async enableWebhook(rawBaseUrl: string): Promise<TelegramBridgeStatus> {
    if (!this.token) {
      throw new Error('TELEGRAM_BOT_TOKEN is not configured.');
    }
    const check = normalizeWebhookBaseUrl(rawBaseUrl);
    if (!check.ok || !check.baseUrl || !check.webhookEndpoint) {
      throw new Error(check.error || 'Invalid webhook base URL.');
    }

    // Probe public reachability BEFORE mutating live Telegram webhook/polling state
    const probeUrl = `${check.baseUrl}/api/telegram/webhook/probe`;
    let probeResp: Response;
    try {
      probeResp = await fetch(probeUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Network error';
      throw new Error(`Could not reach ${probeUrl}: ${msg}`);
    }

    if (probeResp.status === 301 || probeResp.status === 302 || probeResp.status === 307 || probeResp.status === 401 || probeResp.status === 403) {
      throw new Error(
        `Public check blocked (HTTP ${probeResp.status}). That URL requires login/authentication, so Telegram's servers cannot deliver updates there. Enable unauthenticated public access or deploy to Render / Railway / Cloud Run.`
      );
    }
    if (probeResp.status !== 200) {
      throw new Error(
        `Webhook URL returned HTTP ${probeResp.status} at /api/telegram/webhook/probe. Make sure the app is deployed and running at ${check.baseUrl} first.`
      );
    }
    const probeJson = (await probeResp.json().catch(() => null)) as { ok?: boolean; service?: string } | null;
    if (!probeJson?.ok) {
      throw new Error(`Unexpected response from ${probeUrl}. Expected this app's probe JSON.`);
    }

    await this.ensureBotIdentity();
    await this.tgCall('setWebhook', {
      url: check.webhookEndpoint,
      secret_token: this.getWebhookSecret(),
      allowed_updates: ['message', 'edited_message', 'chat_member', 'my_chat_member', 'message_reaction'],
      drop_pending_updates: false,
    });

    this.mode = 'webhook';
    this.webhookUrl = check.webhookEndpoint;
    this.running = true;
    this.pollGeneration += 1;
    this.lastError = null;
    this.lastEvent = `24/7 Webhook active -> ${check.webhookEndpoint}`;
    botDb.setConfig('telegram_mode', 'webhook');
    botDb.setConfig('telegram_webhook_url', check.webhookEndpoint);
    console.log(`[TelegramBridge] ${this.lastEvent}`);
    return this.getStatus();
  }

  public async disableWebhookAndPoll(): Promise<TelegramBridgeStatus> {
    if (!this.token) {
      throw new Error('TELEGRAM_BOT_TOKEN is not configured.');
    }
    botDb.deleteConfig('telegram_mode');
    botDb.deleteConfig('telegram_webhook_url');
    this.mode = 'polling';
    this.webhookUrl = null;
    this.running = false;
    await this.tgCall('deleteWebhook', { drop_pending_updates: false }).catch(() => {});
    await this.start(0);
    return this.getStatus();
  }

  public async handleWebhookUpdate(upd: TgUpdate): Promise<void> {
    if (!this.token || !upd || typeof upd.update_id !== 'number') {
      return;
    }
    await this.ensureBotIdentity();
    this.running = true;
    this.mode = 'webhook';
    this.updatesProcessed += 1;
    this.dispatchUpdate(upd);
  }

  private dispatchUpdate(upd: TgUpdate): void {
    if (upd.my_chat_member) {
      const cmu = upd.my_chat_member;
      this.enqueueChatTask(cmu.chat.id, async () => {
        await this.handleMyChatMember(cmu);
      });
    }
    if (upd.chat_member) {
      try {
        this.handleChatMemberUpdate(upd.chat_member);
      } catch (cmErr) {
        console.error('[TelegramBridge] handleChatMemberUpdate error:', cmErr);
      }
    }
    if (upd.message_reaction?.user && !upd.message_reaction.user.is_bot) {
      const rChat = upd.message_reaction.chat;
      if (rChat.type === 'group' || rChat.type === 'supergroup') {
        botDb.ensureGroup(rChat.id, rChat.title);
        botDb.upsertMember({
          chatId: rChat.id,
          userId: upd.message_reaction.user.id,
          username: upd.message_reaction.user.username ?? null,
          fullName: formatFullName(upd.message_reaction.user),
          isBot: false,
          isActive: true,
        });
      }
    }
    if (upd.edited_message?.from && !upd.edited_message.from.is_bot) {
      const eChat = upd.edited_message.chat;
      if (eChat.type === 'group' || eChat.type === 'supergroup') {
        botDb.ensureGroup(eChat.id, eChat.title);
        botDb.upsertMember({
          chatId: eChat.id,
          userId: upd.edited_message.from.id,
          username: upd.edited_message.from.username ?? null,
          fullName: formatFullName(upd.edited_message.from),
          isBot: false,
          isActive: true,
        });
      }
    }
    if (upd.message) {
      const msg = upd.message;
      this.enqueueChatTask(msg.chat.id, async () => {
        try {
          await withTimeout(this.handleMessage(msg), 60000, 'Message processing');
        } catch (msgErr) {
          const errText = msgErr instanceof Error ? msgErr.message : 'Unexpected handler error';
          console.error('[TelegramBridge] handleMessage error:', msgErr);
          await this.reply(
            msg.chat.id,
            msg.message_id,
            `Error: ${errText}`,
            false,
            msg.message_thread_id
          ).catch(() => {});
        }
      });
    }
  }

  public async start(attempt = 0): Promise<void> {
    if (!this.token) {
      return;
    }
    this.ensureWatchdog();
    if (this.running) {
      return;
    }
    if (this.startingPromise) {
      return this.startingPromise;
    }

    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    this.startingPromise = (async () => {
      try {
        await this.ensureBotIdentity();

        const envWebhookBase = process.env.TELEGRAM_WEBHOOK_URL?.trim();
        if (envWebhookBase) {
          const check = normalizeWebhookBaseUrl(envWebhookBase);
          if (check.ok && check.webhookEndpoint) {
            await this.tgCall('setWebhook', {
              url: check.webhookEndpoint,
              secret_token: this.getWebhookSecret(),
              allowed_updates: ['message', 'edited_message', 'chat_member', 'my_chat_member', 'message_reaction'],
              drop_pending_updates: false,
            });
            this.mode = 'webhook';
            this.webhookUrl = check.webhookEndpoint;
            this.running = true;
            this.lastError = null;
            this.lastEvent = `24/7 Webhook active (@${this.botUsername})`;
            botDb.setConfig('telegram_mode', 'webhook');
            botDb.setConfig('telegram_webhook_url', check.webhookEndpoint);
            console.log(`[TelegramBridge] ${this.lastEvent}`);
            return;
          }
        }

        const savedMode = botDb.getConfig('telegram_mode');
        const savedWebhookUrl = botDb.getConfig('telegram_webhook_url');
        if (savedMode === 'webhook' && savedWebhookUrl) {
          const info = await this.tgCall<{ url?: string }>('getWebhookInfo').catch(() => null);
          if (info?.url && info.url === savedWebhookUrl) {
            this.mode = 'webhook';
            this.webhookUrl = savedWebhookUrl;
            this.running = true;
            this.lastError = null;
            this.lastEvent = `24/7 Webhook active -> ${savedWebhookUrl}`;
            console.log(`[TelegramBridge] ${this.lastEvent}`);
            return;
          }
          botDb.deleteConfig('telegram_mode');
          botDb.deleteConfig('telegram_webhook_url');
        }

        // Clear any previous webhook so long-polling getUpdates works cleanly
        await this.tgCall('deleteWebhook', { drop_pending_updates: false }).catch(() => {});

        this.mode = 'polling';
        this.webhookUrl = null;
        this.running = true;
        this.lastError = null;
        this.consecutivePollErrors = 0;
        this.pollGeneration += 1;
        this.lastPollBeatAt = Date.now();
        this.lastEvent = `Connected as @${this.botUsername} (Group Privacy: ${
          this.canReadAllGroupMessages ? 'OFF' : 'ON'
        })`;
        console.log(`[TelegramBridge] ${this.lastEvent}`);
        void this.pollLoop(this.pollGeneration);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Failed to initialize Telegram bot.';
        this.lastError = errMsg;
        this.running = false;
        this.mode = 'stopped';
        console.error(`[TelegramBridge] Start attempt ${attempt + 1} failed:`, errMsg);

        const isAuthFailure =
          errMsg.toLowerCase().includes('unauthorized') || errMsg.includes('401') || errMsg.includes('404');
        if (!isAuthFailure) {
          const delays = [3000, 5000, 10000, 15000];
          const delayMs = delays[Math.min(attempt, delays.length - 1)];
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            void this.start(attempt + 1);
          }, delayMs);
          this.retryTimer.unref();
        }
      } finally {
        this.startingPromise = null;
      }
    })();

    return this.startingPromise;
  }

  private async pollLoop(gen: number): Promise<void> {
    while (this.running && this.mode === 'polling' && gen === this.pollGeneration) {
      this.lastPollBeatAt = Date.now();
      try {
        const updates = await this.tgCall<TgUpdate[]>('getUpdates', {
          offset: this.offset,
          timeout: 12,
          allowed_updates: ['message', 'edited_message', 'chat_member', 'my_chat_member', 'message_reaction'],
        });
        this.lastPollBeatAt = Date.now();
        this.consecutivePollErrors = 0;
        this.lastError = null;

        for (const upd of updates) {
          this.offset = upd.update_id + 1;
          this.updatesProcessed += 1;
          this.dispatchUpdate(upd);
        }
      } catch (err) {
        if (!this.running || this.mode !== 'polling' || gen !== this.pollGeneration) {
          break;
        }
        const errMsg = err instanceof Error ? err.message : 'Polling error';
        this.consecutivePollErrors += 1;

        if (errMsg.toLowerCase().includes('conflict') || errMsg.includes('409')) {
          console.warn('[TelegramBridge] 409 Conflict during getUpdates; checking if external webhook took over.');
          const info = await this.tgCall<{ url?: string }>('getWebhookInfo').catch(() => null);
          if (info?.url) {
            this.lastError = `External webhook active at ${info.url}. Use polling only when external host is offline, or switch cleanly in Members & Settings.`;
            await new Promise((r) => setTimeout(r, 8000));
          } else {
            await new Promise((r) => setTimeout(r, 2500));
          }
        } else if (isTransientTimeoutOrNetworkError(err)) {
          if (this.consecutivePollErrors >= 3) {
            this.lastError = errMsg;
            console.warn(
              `[TelegramBridge] Repeated transient polling timeout (${this.consecutivePollErrors}x):`,
              errMsg
            );
          } else {
            console.warn('[TelegramBridge] Transient poll timeout, continuing:', errMsg);
          }
          const backoffMs = Math.min(6000, 500 * this.consecutivePollErrors);
          await new Promise((r) => setTimeout(r, backoffMs));
        } else {
          this.lastError = errMsg;
          console.error('[TelegramBridge] pollLoop error:', errMsg);
          await new Promise((r) => setTimeout(r, 3000));
        }
        this.lastPollBeatAt = Date.now();
      }
    }
  }

  private async handleMyChatMember(cmu: TgChatMemberUpdated): Promise<void> {
    const chatId = cmu.chat.id;
    const isGroup = cmu.chat.type === 'group' || cmu.chat.type === 'supergroup';
    if (!isGroup) return;

    const oldStatus = cmu.old_chat_member?.status;
    const status = cmu.new_chat_member.status;
    this.lastEvent = `Bot status in "${cmu.chat.title || chatId}" changed to ${status}`;
    if (status === 'left' || status === 'kicked') return;

    botDb.ensureGroup(chatId, cmu.chat.title);
    await this.syncAdmins(chatId);

    const wasOutside = !oldStatus || oldStatus === 'left' || oldStatus === 'kicked';
    if (wasOutside && (status === 'member' || status === 'administrator')) {
      const greetingHtml = escapeHtml(formatBotGroupAddedGreeting(cmu.chat.title));
      // Wait briefly so message.new_chat_members replies first if Telegram sends both updates
      setTimeout(() => {
        if (this.shouldSendWelcomeOnce(chatId, this.botId)) {
          void this.sendMessage(chatId, greetingHtml, true).catch(() => {});
        }
      }, 800);
    }
  }

  private handleChatMemberUpdate(cmu: TgChatMemberUpdated): void {
    const chatId = cmu.chat.id;
    const u = cmu.new_chat_member.user;
    const oldStatus = cmu.old_chat_member?.status;
    const status = cmu.new_chat_member.status;
    botDb.ensureGroup(chatId, cmu.chat.title);

    if (status === 'left' || status === 'kicked') {
      botDb.setMemberActive(chatId, u.id, false);
      return;
    }

    const fullName = formatFullName(u);
    botDb.upsertMember({
      chatId,
      userId: u.id,
      username: u.username ?? null,
      fullName,
      role: mapTgStatusToRole(status),
      isBot: u.is_bot,
      isActive: true,
    });

    const isGroup = cmu.chat.type === 'group' || cmu.chat.type === 'supergroup';
    const justJoined = (oldStatus === 'left' || oldStatus === 'kicked') && status === 'member';
    if (isGroup && justJoined && !u.is_bot) {
      setTimeout(() => {
        const settings = botDb.getGroupSettings(chatId);
        if (!settings.welcome_enabled) return;
        if (!this.shouldSendWelcomeOnce(chatId, u.id)) return;
        const welcomeHtml = renderWelcomeMessage(
          settings.welcome_text,
          { user_id: u.id, full_name: fullName, username: u.username ?? null },
          cmu.chat.title || 'this group',
          'html'
        );
        void this.sendMessage(chatId, welcomeHtml, true).catch(() => {});
      }, 800);
    }
  }

  private async syncAdmins(chatId: number): Promise<void> {
    try {
      const admins = await this.tgCall<TgChatMember[]>('getChatAdministrators', { chat_id: chatId });
      for (const adm of admins) {
        if (!adm.user.is_bot) {
          botDb.upsertMember({
            chatId,
            userId: adm.user.id,
            username: adm.user.username ?? null,
            fullName: formatFullName(adm.user),
            role: mapTgStatusToRole(adm.status),
            isBot: false,
            isActive: true,
          });
        }
      }
    } catch {
      // Ignore if Telegram forbids admin lookup
    }
  }

  private async sendMessage(
    chatId: number,
    text: string,
    htmlMode = false,
    threadId?: number
  ): Promise<void> {
    for (const chunk of chunkTelegramText(text)) {
      await this.tgCall('sendMessage', {
        chat_id: chatId,
        text: chunk,
        ...(htmlMode ? { parse_mode: 'HTML' } : {}),
        ...(threadId ? { message_thread_id: threadId } : {}),
      });
    }
  }

  private async reply(
    chatId: number,
    replyToId: number,
    text: string,
    htmlMode = false,
    threadId?: number
  ): Promise<number | null> {
    let firstMessageId: number | null = null;
    for (const chunk of chunkTelegramText(text)) {
      const sent = await this.tgCall<{ message_id: number }>('sendMessage', {
        chat_id: chatId,
        reply_parameters: {
          message_id: replyToId,
          allow_sending_without_reply: true,
        },
        text: chunk,
        ...(htmlMode ? { parse_mode: 'HTML' } : {}),
        ...(threadId ? { message_thread_id: threadId } : {}),
      });
      if (firstMessageId === null && sent?.message_id) {
        firstMessageId = sent.message_id;
      }
    }
    return firstMessageId;
  }

  private async sendHtmlAtomic(
    chatId: number,
    htmlText: string,
    replyToId?: number,
    threadId?: number
  ): Promise<void> {
    try {
      await this.tgCall('sendMessage', {
        chat_id: chatId,
        text: htmlText,
        parse_mode: 'HTML',
        ...(replyToId
          ? {
              reply_parameters: {
                message_id: replyToId,
                allow_sending_without_reply: true,
              },
            }
          : {}),
        ...(threadId ? { message_thread_id: threadId } : {}),
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : '';
      if (ownerMtproto.isReady()) {
        const mtRes = await ownerMtproto.sendGroupHtmlMessage({
          chatId,
          htmlText,
          replyToMessageId: replyToId,
        });
        if (mtRes.ok) {
          return;
        }
      }
      // If Bot API rejects a specific tg://user?id= link due to privacy or unknown user, unwrap unreachable anchors cleanly and resend
      if (
        errMsg.toLowerCase().includes('wrong user_id') ||
        errMsg.toLowerCase().includes('privacy') ||
        errMsg.toLowerCase().includes("can't parse entities")
      ) {
        const matches = [...htmlText.matchAll(/<a href="tg:\/\/user\?id=(\d+)">([^<]*)<\/a>/g)];
        let sanitized = htmlText;
        for (const m of matches) {
          const uid = Number(m[1]);
          const cm = await this.getChatMemberSafe(chatId, uid);
          if (!cm) {
            sanitized = sanitized.replace(m[0], m[2]);
          }
        }
        if (sanitized !== htmlText) {
          await this.tgCall('sendMessage', {
            chat_id: chatId,
            text: sanitized,
            parse_mode: 'HTML',
            ...(replyToId
              ? {
                  reply_parameters: {
                    message_id: replyToId,
                    allow_sending_without_reply: true,
                  },
                }
              : {}),
            ...(threadId ? { message_thread_id: threadId } : {}),
          });
          return;
        }
      }
      throw err;
    }
  }

  private async getChatMemberSafe(chatId: number, userId: number): Promise<TgChatMember | null> {
    try {
      return await this.tgCall<TgChatMember>('getChatMember', {
        chat_id: chatId,
        user_id: userId,
      });
    } catch {
      return null;
    }
  }

  private async isUserAdmin(
    msg: TgMessage,
    userId?: number,
    requiredRight?: BotPermissionKey
  ): Promise<boolean> {
    if (msg.chat.type === 'private') return true;
    if (msg.sender_chat && msg.sender_chat.id === msg.chat.id && userId === undefined) {
      return true;
    }
    const targetId = userId ?? msg.from?.id;
    if (!targetId) return false;
    if (targetId === 1087968824) return true;
    const member = await this.getChatMemberSafe(msg.chat.id, targetId);
    if (!member) return false;
    if (member.status === 'creator') return true;
    if (member.status !== 'administrator') return false;
    if (requiredRight) {
      return Boolean(member[requiredRight]);
    }
    return true;
  }

  private async getBotMember(chatId: number): Promise<TgChatMember | null> {
    return this.getChatMemberSafe(chatId, this.botId);
  }

  private getRealReplyMessage(msg: TgMessage): TgMessage | null {
    const rMsg = msg.reply_to_message;
    if (!rMsg) return null;
    if (rMsg.forum_topic_created !== undefined) return null;
    if (msg.message_thread_id && rMsg.message_id === msg.message_thread_id) return null;
    return rMsg;
  }

  private async resolveTargetContext(
    msg: TgMessage,
    args: string[]
  ): Promise<{
    member: GroupMember | null;
    liveCm: TgChatMember | null;
    numericUserId?: number | null;
    resolvedFromReply: boolean;
    remainingArgs: string[];
    error?: string;
  }> {
    const chatId = msg.chat.id;
    const realReply = this.getRealReplyMessage(msg);
    if (realReply) {
      const rMsg = realReply;
      if (rMsg.sender_chat && (!rMsg.from || SYSTEM_TG_ACCOUNT_IDS.has(rMsg.from.id))) {
        return {
          member: null,
          liveCm: null,
          resolvedFromReply: true,
          remainingArgs: args,
          error: 'Cannot target anonymous admin or linked channel posts.',
        };
      }
      if (rMsg.from) {
        const u = rMsg.from;
        if (SYSTEM_TG_ACCOUNT_IDS.has(u.id)) {
          return {
            member: null,
            liveCm: null,
            resolvedFromReply: true,
            remainingArgs: args,
            error: 'Cannot target anonymous admin or Telegram system accounts.',
          };
        }
        const liveCm = await this.getChatMemberSafe(chatId, u.id);
        const member = botDb.upsertMember({
          chatId,
          userId: u.id,
          username: u.username ?? null,
          fullName: formatFullName(u),
          role: liveCm ? mapTgStatusToRole(liveCm.status) : undefined,
          isBot: u.is_bot,
          isActive: liveCm ? liveCm.status !== 'left' && liveCm.status !== 'kicked' : true,
        });
        return { member, liveCm, numericUserId: u.id, resolvedFromReply: true, remainingArgs: args };
      }
    }

    const rawText = msg.text ?? msg.caption ?? '';
    const entities = msg.entities ?? msg.caption_entities ?? [];
    for (const ent of entities) {
      if (ent.type === 'text_mention' && ent.user) {
        const u = ent.user;
        const liveCm = await this.getChatMemberSafe(chatId, u.id);
        const member = botDb.upsertMember({
          chatId,
          userId: u.id,
          username: u.username ?? null,
          fullName: formatFullName(u),
          role: liveCm ? mapTgStatusToRole(liveCm.status) : undefined,
          isBot: u.is_bot,
          isActive: liveCm ? liveCm.status !== 'left' && liveCm.status !== 'kicked' : true,
        });
        const tail = rawText.slice(ent.offset + ent.length).trim();
        return {
          member,
          liveCm,
          numericUserId: u.id,
          resolvedFromReply: false,
          remainingArgs: tail ? tail.split(/\s+/) : [],
        };
      }
    }

    const members = botDb.getMembers(chatId);
    const res = resolveTargetWithArgs(args, null, members, { botUsername: this.botUsername });
    if (res.member) {
      const liveCm = await this.getChatMemberSafe(chatId, res.member.user_id);
      const member = liveCm
        ? botDb.upsertMember({
            chatId,
            userId: liveCm.user.id,
            username: liveCm.user.username ?? null,
            fullName: formatFullName(liveCm.user),
            role: mapTgStatusToRole(liveCm.status),
            isBot: liveCm.user.is_bot,
            isActive: liveCm.status !== 'left' && liveCm.status !== 'kicked',
          })
        : res.member;
      return { member, liveCm, numericUserId: member.user_id, resolvedFromReply: false, remainingArgs: res.remainingArgs };
    }

    if (res.numericUserId !== null) {
      if (SYSTEM_TG_ACCOUNT_IDS.has(res.numericUserId)) {
        return {
          member: null,
          liveCm: null,
          resolvedFromReply: false,
          remainingArgs: res.remainingArgs,
          error: 'Cannot target anonymous admin or Telegram system accounts.',
        };
      }
      const cm = await this.getChatMemberSafe(chatId, res.numericUserId);
      if (cm) {
        const member = botDb.upsertMember({
          chatId,
          userId: cm.user.id,
          username: cm.user.username ?? null,
          fullName: formatFullName(cm.user),
          role: mapTgStatusToRole(cm.status),
          isBot: cm.user.is_bot,
          isActive: cm.status !== 'left' && cm.status !== 'kicked',
        });
        return { member, liveCm: cm, numericUserId: cm.user.id, resolvedFromReply: false, remainingArgs: res.remainingArgs };
      }
      return { member: null, liveCm: null, numericUserId: res.numericUserId, resolvedFromReply: false, remainingArgs: res.remainingArgs };
    }

    if (res.mentionUsername) {
      const globalMatch = botDb.findMemberByUsernameGlobal(res.mentionUsername);
      if (globalMatch) {
        const liveCm = await this.getChatMemberSafe(chatId, globalMatch.user_id);
        const member = botDb.upsertMember({
          chatId,
          userId: liveCm ? liveCm.user.id : globalMatch.user_id,
          username: liveCm ? liveCm.user.username ?? res.mentionUsername : globalMatch.username ?? res.mentionUsername,
          fullName: liveCm ? formatFullName(liveCm.user) : globalMatch.full_name,
          role: liveCm ? mapTgStatusToRole(liveCm.status) : undefined,
          isBot: liveCm ? liveCm.user.is_bot : globalMatch.is_bot,
          isActive: liveCm ? liveCm.status !== 'left' && liveCm.status !== 'kicked' : true,
        });
        return { member, liveCm, resolvedFromReply: false, remainingArgs: res.remainingArgs };
      }

      if (ownerMtproto.isReady()) {
        const mtMatch = await ownerMtproto.resolveUsernameInChat(chatId, res.mentionUsername);
        if (mtMatch) {
          const liveCm = await this.getChatMemberSafe(chatId, mtMatch.userId);
          const member = botDb.upsertMember({
            chatId,
            userId: mtMatch.userId,
            username: liveCm ? liveCm.user.username ?? mtMatch.username : mtMatch.username,
            fullName: liveCm ? formatFullName(liveCm.user) : mtMatch.fullName,
            role: liveCm ? mapTgStatusToRole(liveCm.status) : undefined,
            isBot: liveCm ? liveCm.user.is_bot : mtMatch.isBot,
            isActive: liveCm ? liveCm.status !== 'left' && liveCm.status !== 'kicked' : true,
          });
          return { member, liveCm, resolvedFromReply: false, remainingArgs: res.remainingArgs };
        }
      }

      return {
        member: null,
        liveCm: null,
        resolvedFromReply: false,
        remainingArgs: res.remainingArgs,
        error:
          `Could not resolve @${res.mentionUsername} yet — Telegram's Bot API cannot look up @usernames unless that user has sent a message or joined while the bot is running. ` +
          `Reply to any message from @${res.mentionUsername}, pass their numeric User ID, or link Owner Override in Members & Settings so @username works on all members.`,
      };
    }

    return { member: null, liveCm: null, resolvedFromReply: false, remainingArgs: args };
  }

  private async resolveTarget(msg: TgMessage, args: string[]): Promise<GroupMember | null> {
    return (await this.resolveTargetContext(msg, args)).member;
  }

  private verifyTarget(
    msg: TgMessage,
    action: ModerationAction,
    targetCtx: { member: GroupMember | null; liveCm: TgChatMember | null; error?: string }
  ): { ok: boolean; reasonHtml?: string; ownerLocked?: boolean } {
    if (targetCtx.error) {
      return { ok: false, reasonHtml: escapeHtml(targetCtx.error) };
    }
    const target = targetCtx.member;
    if (!target) {
      return { ok: false, reasonHtml: `Reply to a user or provide @username/ID to ${escapeHtml(action)}.` };
    }
    if ((action === 'mute' || action === 'unmute' || action === 'promote' || action === 'demote') && msg.chat.type !== 'supergroup') {
      return {
        ok: false,
        reasonHtml: `<code>/${escapeHtml(action)}</code> requires the group to be upgraded to a Telegram Supergroup.`,
      };
    }
    const validation = validateModerationTarget({
      action,
      actorId: msg.from?.id ?? null,
      botId: this.botId,
      targetId: target.user_id,
      targetName: target.full_name,
      targetStatus: targetCtx.liveCm?.status ?? (target.role === 'owner' ? 'creator' : target.role === 'administrator' ? 'administrator' : null),
      targetIsBot: targetCtx.liveCm?.user.is_bot ?? target.is_bot,
      targetCanBeEdited: targetCtx.liveCm?.can_be_edited ?? null,
    });
    if (!validation.allowed) {
      return {
        ok: false,
        ownerLocked: validation.ownerLocked,
        reasonHtml: validation.reason ? escapeHtml(validation.reason) : undefined,
      };
    }
    return { ok: true };
  }

  private async checkModReady(
    msg: TgMessage,
    commandName: string,
    requiredBotRights: BotPermissionKey[] = ['can_restrict_members'],
    requiredActorRight?: BotPermissionKey
  ): Promise<TgChatMember | null> {
    if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') {
      await this.reply(msg.chat.id, msg.message_id, 'This command works only in groups.', false, msg.message_thread_id);
      return null;
    }
    if (!(await this.isUserAdmin(msg))) {
      await this.reply(msg.chat.id, msg.message_id, 'You must be a group admin to use this command.', false, msg.message_thread_id);
      return null;
    }
    if (requiredActorRight && !(await this.isUserAdmin(msg, undefined, requiredActorRight))) {
      await this.reply(
        msg.chat.id,
        msg.message_id,
        `You lack the required admin permission for /${escapeHtml(commandName)}.`,
        true,
        msg.message_thread_id
      );
      return null;
    }
    const botMember = await this.getBotMember(msg.chat.id);
    const check = evaluateBotAdminPermissions(botMember, requiredBotRights, commandName);
    if (!check.ok) {
      await this.reply(msg.chat.id, msg.message_id, check.debugHtml, true, msg.message_thread_id);
      return null;
    }
    return botMember;
  }

  private async handleMessage(msg: TgMessage): Promise<void> {
    const chatId = msg.chat.id;
    const threadId = msg.message_thread_id;
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    if (isGroup) {
      botDb.ensureGroup(chatId, msg.chat.title);
    }

    if (msg.new_chat_members?.length) {
      const settings = botDb.getGroupSettings(chatId);
      for (const member of msg.new_chat_members) {
        const fullName = formatFullName(member);
        botDb.upsertMember({
          chatId,
          userId: member.id,
          username: member.username ?? null,
          fullName,
          isBot: member.is_bot,
          isActive: true,
        });
        if (member.id === this.botId) {
          await this.syncAdmins(chatId);
          if (this.shouldSendWelcomeOnce(chatId, this.botId)) {
            await this.reply(
              chatId,
              msg.message_id,
              escapeHtml(formatBotGroupAddedGreeting(msg.chat.title)),
              true,
              threadId
            );
          }
          continue;
        }
        if (settings.welcome_enabled && !member.is_bot && this.shouldSendWelcomeOnce(chatId, member.id)) {
          const welcomeHtml = renderWelcomeMessage(
            settings.welcome_text,
            { user_id: member.id, full_name: fullName, username: member.username ?? null },
            msg.chat.title || 'this group',
            'html'
          );
          await this.reply(chatId, msg.message_id, welcomeHtml, true, threadId);
        }
      }
      return;
    }

    if (msg.left_chat_member && isGroup) {
      botDb.setMemberActive(chatId, msg.left_chat_member.id, false);
      return;
    }

    if (msg.from && isGroup) {
      botDb.upsertMember({
        chatId,
        userId: msg.from.id,
        username: msg.from.username ?? null,
        fullName: formatFullName(msg.from),
        isBot: msg.from.is_bot,
        isActive: true,
        incrementMsg: true,
      });
    }

    const passiveReply = this.getRealReplyMessage(msg);
    if (passiveReply?.from && isGroup && !passiveReply.from.is_bot) {
      const ru = passiveReply.from;
      botDb.upsertMember({
        chatId,
        userId: ru.id,
        username: ru.username ?? null,
        fullName: formatFullName(ru),
        isBot: false,
        isActive: true,
      });
    }

    if (isGroup) {
      const extraUsers: TgUser[] = [];
      if (msg.forward_from && !msg.forward_from.is_bot) extraUsers.push(msg.forward_from);
      if (msg.pinned_message?.from && !msg.pinned_message.from.is_bot) extraUsers.push(msg.pinned_message.from);
      for (const ent of [...(msg.entities ?? []), ...(msg.caption_entities ?? [])]) {
        if (ent.type === 'text_mention' && ent.user && !ent.user.is_bot) {
          extraUsers.push(ent.user);
        }
      }
      for (const eu of extraUsers) {
        botDb.upsertMember({
          chatId,
          userId: eu.id,
          username: eu.username ?? null,
          fullName: formatFullName(eu),
          isBot: false,
          isActive: true,
        });
      }
    }

    const rawText = (msg.text || msg.caption || '').trim();
    const parsed = parseCommand(rawText);

    if (parsed) {
      this.lastEvent = `Command /${parsed.command} in ${msg.chat.title || msg.chat.type} (${chatId})`;
      const cmd = parsed.command;
      switch (cmd) {
        case 'start': {
          await this.reply(
            chatId,
            msg.message_id,
            `Hello! I am <b>${escapeHtml(this.botFirstName)}</b>\n\n` +
              `I combine <b>Rose-style Group Management</b>, <b>Single-Message Tag All</b>, ` +
              `<b>Live Weather</b>, <b>Admin User Info</b>, and a <b>CA-Specialized Gemini AI Guider</b> (text & audio)!\n\n` +
              `Tag <code>@${escapeHtml(this.botUsername)}</code> with any CA question or voice/audio note, or send /help.`,
            true,
            threadId
          );
          return;
        }
        case 'help': {
          await this.reply(
            chatId,
            msg.message_id,
            `<b>Bot Command Guide</b>\n\n` +
              `<b>CA Exam Guider (CA Only):</b>\n` +
              `• Mention <code>@${escapeHtml(this.botUsername)}</code> with text or audio/voice\n` +
              `• Reply to a voice/audio message with <code>@${escapeHtml(this.botUsername)}</code>\n\n` +
              `<b>Tag All (Admins):</b>\n• /tagall [note] — Tag all group members in one message\n\n` +
              `<b>Moderation (Admins):</b>\n` +
              `• /ban | /tban &lt;time&gt; | /unban | /kick\n` +
              `• /mute [30m|2h|1d] | /tmute &lt;time&gt; | /unmute\n` +
              `• /promote [title] | /demote\n` +
              `• /warn | /warns | /resetwarns | /del\n` +
              `• /pin | /unpin | /adminlist\n` +
              `• /setwelcome &lt;text&gt; | /welcome on|off\n` +
              `• /setrules &lt;text&gt; | /rules\n\n` +
              `<b>Info & Weather:</b>\n• /info (Admin) | /weather &lt;city&gt; | /id`,
            true,
            threadId
          );
          return;
        }
        case 'id': {
          const realReply = this.getRealReplyMessage(msg);
          if (parsed.args.length > 0 || realReply) {
            const targetCtx = await this.resolveTargetContext(msg, parsed.args);
            if (targetCtx.error) {
              await this.reply(chatId, msg.message_id, escapeHtml(targetCtx.error), true, threadId);
              return;
            }
            if (targetCtx.member) {
              await this.reply(
                chatId,
                msg.message_id,
                `<b>Chat ID:</b> <code>${chatId}</code>\n<b>User ID:</b> <code>${targetCtx.member.user_id}</code> (${mentionHtml(targetCtx.member.user_id, targetCtx.member.full_name)})`,
                true,
                threadId
              );
              return;
            }
            if (targetCtx.numericUserId !== null) {
              await this.reply(
                chatId,
                msg.message_id,
                `<b>Chat ID:</b> <code>${chatId}</code>\n<b>User ID:</b> <code>${targetCtx.numericUserId}</code>`,
                true,
                threadId
              );
              return;
            }
          }
          const target = realReply?.from ?? msg.from;
          if (!target) return;
          await this.reply(
            chatId,
            msg.message_id,
            `<b>Chat ID:</b> <code>${chatId}</code>\n<b>User ID:</b> <code>${target.id}</code> (${mentionHtml(target.id, formatFullName(target))})`,
            true,
            threadId
          );
          return;
        }
        case 'weather': {
          if (!parsed.rawArgs) {
            await this.reply(chatId, msg.message_id, 'Usage: <code>/weather Delhi</code>', true, threadId);
            return;
          }
          try {
            const wx = await fetchWeatherForCity(parsed.rawArgs);
            const html =
              `<b>Weather in ${escapeHtml(wx.place)}</b>\n` +
              `• Condition: ${escapeHtml(wx.condition)}\n` +
              `• Temperature: <b>${wx.temperatureC}°C</b> (Feels like ${wx.apparentTemperatureC}°C)\n` +
              `• Min / Max: ${wx.minTempC}°C / ${wx.maxTempC}°C\n` +
              `• Humidity: ${wx.humidityPct}%\n` +
              `• Wind: ${wx.windKmh} km/h`;
            await this.reply(chatId, msg.message_id, html, true, threadId);
          } catch (err) {
            await this.reply(chatId, msg.message_id, err instanceof Error ? err.message : 'Weather lookup failed.', false, threadId);
          }
          return;
        }
        case 'tagall': {
          if (!isGroup) {
            await this.reply(chatId, msg.message_id, 'This command can only be used in groups.', false, threadId);
            return;
          }
          if (!(await this.isUserAdmin(msg))) {
            await this.reply(chatId, msg.message_id, 'Only group admins can use /tagall.', false, threadId);
            return;
          }
          const botMember = await this.getBotMember(chatId);
          const permCheck = evaluateBotAdminPermissions(
            botMember,
            ['can_delete_messages', 'can_restrict_members'],
            'tagall'
          );
          if (!permCheck.ok) {
            await this.reply(chatId, msg.message_id, permCheck.debugHtml, true, threadId);
            return;
          }

          await this.syncAdmins(chatId);
          if (ownerMtproto.isReady()) {
            await withTimeout(ownerMtproto.syncGroupParticipants(chatId), 10000, 'Participant sync').catch(
              () => ({ ok: false, syncedCount: 0 })
            );
          }
          const members = botDb.getMembers(chatId);
          const chunked = buildTagAllChunks(members, parsed.rawArgs);
          for (let i = 0; i < chunked.chunks.length; i++) {
            const chunk = chunked.chunks[i];
            if (i === 0) {
              await this.sendHtmlAtomic(chatId, chunk.htmlText, msg.message_id, threadId);
            } else {
              await new Promise((r) => setTimeout(r, 550));
              await this.sendHtmlAtomic(chatId, chunk.htmlText, undefined, threadId);
            }
          }
          return;
        }
        case 'adminlist':
        case 'admins': {
          if (!isGroup) {
            await this.reply(chatId, msg.message_id, 'This command works only in groups.', false, threadId);
            return;
          }
          await this.syncAdmins(chatId);
          const admins = await this.tgCall<TgChatMember[]>('getChatAdministrators', { chat_id: chatId });
          const adminLines = admins
            .filter((a) => !a.user.is_bot)
            .map((a) => {
              const badge =
                a.status === 'creator'
                  ? 'Owner 👑'
                  : a.can_be_edited
                    ? 'Admin · Bot-managed ✅'
                    : 'Admin · Owner-promoted 🔒';
              return `• ${mentionHtml(a.user.id, formatFullName(a.user))} (${badge})`;
            });
          const botMember = await this.getBotMember(chatId);
          const botPermSummary = evaluateBotAdminPermissions(
            botMember,
            ['can_delete_messages', 'can_restrict_members', 'can_pin_messages', 'can_promote_members'],
            'adminlist'
          );
          await this.reply(
            chatId,
            msg.message_id,
            `<b>Group Admins (${adminLines.length})</b>\n${adminLines.join('\n') || 'None'}\n\n${botPermSummary.debugHtml}`,
            true,
            threadId
          );
          return;
        }
        case 'info': {
          if (isGroup && !(await this.isUserAdmin(msg))) {
            await this.reply(chatId, msg.message_id, 'Only group admins can check member info.', false, threadId);
            return;
          }
          const targetCtx = await this.resolveTargetContext(msg, parsed.args);
          if (targetCtx.error) {
            await this.reply(chatId, msg.message_id, escapeHtml(targetCtx.error), true, threadId);
            return;
          }
          const target = targetCtx.member;
          if (!target) {
            await this.reply(
              chatId,
              msg.message_id,
              'Usage: Reply to a user with <code>/info</code> or pass <code>/info @username</code> or <code>/info 123456789</code>.',
              true,
              threadId
            );
            return;
          }
          const settings = botDb.getGroupSettings(chatId);
          const unameDisplay = target.username ? `@${escapeHtml(target.username)}` : 'None';
          await this.reply(
            chatId,
            msg.message_id,
            `<b>User Information</b>\n` +
              `• <b>Name:</b> ${mentionHtml(target.user_id, target.full_name)}\n` +
              `• <b>User ID:</b> <code>${target.user_id}</code>\n` +
              `• <b>Username:</b> ${unameDisplay}\n` +
              `• <b>Group Role:</b> ${escapeHtml(target.role)}\n` +
              `• <b>Is Bot:</b> ${target.is_bot ? 'Yes' : 'No'}\n` +
              `• <b>Warnings:</b> ${target.warns}/${settings.max_warns}\n` +
              `• <b>Tracked Messages:</b> ${target.msg_count}\n` +
              `• <b>First Seen:</b> ${escapeHtml(target.first_seen)}\n` +
              `• <b>Last Seen:</b> ${escapeHtml(target.last_seen)}`,
            true,
            threadId
          );
          return;
        }
        case 'ban':
        case 'tban': {
          if (!(await this.checkModReady(msg, cmd, ['can_restrict_members'], 'can_restrict_members'))) return;
          const targetCtx = await this.resolveTargetContext(msg, parsed.args);
          const check = this.verifyTarget(msg, 'ban', targetCtx);
          if (!check.ok || !targetCtx.member) {
            await this.reply(chatId, msg.message_id, check.reasonHtml || 'Cannot ban target.', true, threadId);
            return;
          }
          const target = targetCtx.member;
          const mins = extractMuteMinutes(targetCtx.remainingArgs, targetCtx.resolvedFromReply, target.user_id);
          if (cmd === 'tban' && !mins) {
            await this.reply(
              chatId,
              msg.message_id,
              'Usage: <code>/tban @user &lt;time&gt;</code> (e.g. <code>30m</code>, <code>2h</code>, <code>1d</code>). Use <code>/ban</code> for a permanent ban.',
              true,
              threadId
            );
            return;
          }
          const untilUnix = mins ? Math.floor(Date.now() / 1000) + mins * 60 : undefined;
          try {
            await this.tgCall('banChatMember', {
              chat_id: chatId,
              user_id: target.user_id,
              ...(untilUnix ? { until_date: untilUnix } : {}),
            });
          } catch (banErr) {
            await this.reply(
              chatId,
              msg.message_id,
              formatTelegramModErrorHtml('ban', mentionHtml(target.user_id, target.full_name), banErr, cmd),
              true,
              threadId
            );
            return;
          }
          botDb.setMemberActive(chatId, target.user_id, false);
          await this.reply(
            chatId,
            msg.message_id,
            `Banned ${mentionHtml(target.user_id, target.full_name)}${mins ? ` for ${mins} min` : ''}.`,
            true,
            threadId
          );
          return;
        }
        case 'unban': {
          if (!(await this.checkModReady(msg, 'unban', ['can_restrict_members'], 'can_restrict_members'))) return;
          const targetCtx = await this.resolveTargetContext(msg, parsed.args);
          const check = this.verifyTarget(msg, 'unban', targetCtx);
          if (!check.ok || !targetCtx.member) {
            await this.reply(chatId, msg.message_id, check.reasonHtml || 'Cannot unban target.', true, threadId);
            return;
          }
          const target = targetCtx.member;
          try {
            await this.tgCall('unbanChatMember', {
              chat_id: chatId,
              user_id: target.user_id,
              only_if_banned: true,
            });
          } catch (unbanErr) {
            await this.reply(
              chatId,
              msg.message_id,
              formatTelegramModErrorHtml('unban', mentionHtml(target.user_id, target.full_name), unbanErr, 'unban'),
              true,
              threadId
            );
            return;
          }
          botDb.setMemberActive(chatId, target.user_id, true);
          await this.reply(chatId, msg.message_id, `Unbanned ${mentionHtml(target.user_id, target.full_name)}.`, true, threadId);
          return;
        }
        case 'kick': {
          if (!(await this.checkModReady(msg, 'kick', ['can_restrict_members'], 'can_restrict_members'))) return;
          const targetCtx = await this.resolveTargetContext(msg, parsed.args);
          const check = this.verifyTarget(msg, 'kick', targetCtx);
          if (!check.ok || !targetCtx.member) {
            await this.reply(chatId, msg.message_id, check.reasonHtml || 'Cannot kick target.', true, threadId);
            return;
          }
          const target = targetCtx.member;
          try {
            await this.tgCall('banChatMember', { chat_id: chatId, user_id: target.user_id });
          } catch (kickErr) {
            await this.reply(
              chatId,
              msg.message_id,
              formatTelegramModErrorHtml('kick', mentionHtml(target.user_id, target.full_name), kickErr, 'kick'),
              true,
              threadId
            );
            return;
          }
          await this.tgCall('unbanChatMember', {
            chat_id: chatId,
            user_id: target.user_id,
            only_if_banned: true,
          }).catch(() => {});
          botDb.setMemberActive(chatId, target.user_id, false);
          await this.reply(chatId, msg.message_id, `Kicked ${mentionHtml(target.user_id, target.full_name)}.`, true, threadId);
          return;
        }
        case 'mute':
        case 'tmute': {
          if (!(await this.checkModReady(msg, cmd, ['can_restrict_members'], 'can_restrict_members'))) return;
          const targetCtx = await this.resolveTargetContext(msg, parsed.args);
          const check = this.verifyTarget(msg, 'mute', targetCtx);
          if (!check.ok || !targetCtx.member) {
            await this.reply(chatId, msg.message_id, check.reasonHtml || 'Cannot mute target.', true, threadId);
            return;
          }
          const target = targetCtx.member;
          const mins = extractMuteMinutes(targetCtx.remainingArgs, targetCtx.resolvedFromReply, target.user_id);
          if (cmd === 'tmute' && !mins) {
            await this.reply(
              chatId,
              msg.message_id,
              'Usage: <code>/tmute @user &lt;time&gt;</code> (e.g. <code>30m</code>, <code>2h</code>, <code>1d</code>). Use <code>/mute</code> for a permanent mute.',
              true,
              threadId
            );
            return;
          }
          const untilUnix = mins ? Math.floor(Date.now() / 1000) + mins * 60 : undefined;
          try {
            await this.tgCall('restrictChatMember', {
              chat_id: chatId,
              user_id: target.user_id,
              permissions: {
                can_send_messages: false,
                can_send_audios: false,
                can_send_documents: false,
                can_send_photos: false,
                can_send_videos: false,
                can_send_video_notes: false,
                can_send_voice_notes: false,
                can_send_polls: false,
                can_send_other_messages: false,
                can_add_web_page_previews: false,
              },
              ...(untilUnix ? { until_date: untilUnix } : {}),
            });
          } catch (muteErr) {
            await this.reply(
              chatId,
              msg.message_id,
              formatTelegramModErrorHtml('mute', mentionHtml(target.user_id, target.full_name), muteErr, cmd),
              true,
              threadId
            );
            return;
          }
          botDb.setMemberMuted(
            chatId,
            target.user_id,
            true,
            mins ? new Date(Date.now() + mins * 60000).toISOString() : null
          );
          await this.reply(
            chatId,
            msg.message_id,
            `Muted ${mentionHtml(target.user_id, target.full_name)}${mins ? ` for ${mins} min` : ''}.`,
            true,
            threadId
          );
          return;
        }
        case 'unmute': {
          if (!(await this.checkModReady(msg, 'unmute', ['can_restrict_members'], 'can_restrict_members'))) return;
          const targetCtx = await this.resolveTargetContext(msg, parsed.args);
          const check = this.verifyTarget(msg, 'unmute', targetCtx);
          if (!check.ok || !targetCtx.member) {
            await this.reply(chatId, msg.message_id, check.reasonHtml || 'Cannot unmute target.', true, threadId);
            return;
          }
          const target = targetCtx.member;
          let restorePerms: TgChatPermissions = {
            can_send_messages: true,
            can_send_audios: true,
            can_send_documents: true,
            can_send_photos: true,
            can_send_videos: true,
            can_send_video_notes: true,
            can_send_voice_notes: true,
            can_send_polls: true,
            can_send_other_messages: true,
            can_add_web_page_previews: true,
          };
          try {
            const chatInfo = await this.tgCall<TgChat>('getChat', { chat_id: chatId });
            if (chatInfo.permissions) {
              restorePerms = { ...restorePerms, ...chatInfo.permissions, can_send_messages: true };
            }
          } catch {
            // fallback to full permissions
          }
          try {
            await this.tgCall('restrictChatMember', {
              chat_id: chatId,
              user_id: target.user_id,
              permissions: restorePerms,
            });
          } catch (unmuteErr) {
            await this.reply(
              chatId,
              msg.message_id,
              formatTelegramModErrorHtml('unmute', mentionHtml(target.user_id, target.full_name), unmuteErr, 'unmute'),
              true,
              threadId
            );
            return;
          }
          botDb.setMemberMuted(chatId, target.user_id, false, null);
          await this.reply(chatId, msg.message_id, `Unmuted ${mentionHtml(target.user_id, target.full_name)}.`, true, threadId);
          return;
        }
        case 'promote': {
          let botMember: TgChatMember | null = null;
          const ownerReady = ownerMtproto.isReady();
          if (ownerReady) {
            if (!isGroup) {
              await this.reply(chatId, msg.message_id, 'This command works only in groups.', false, threadId);
              return;
            }
            if (!(await this.isUserAdmin(msg, undefined, 'can_promote_members'))) {
              await this.reply(chatId, msg.message_id, 'You must be an admin with Add New Admins permission to use /promote.', false, threadId);
              return;
            }
            botMember = await this.getBotMember(chatId);
          } else {
            botMember = await this.checkModReady(msg, 'promote', ['can_promote_members'], 'can_promote_members');
            if (!botMember) return;
          }

          const targetCtx = await this.resolveTargetContext(msg, parsed.args);
          const check = this.verifyTarget(msg, 'promote', targetCtx);
          if (!targetCtx.member) {
            await this.reply(
              chatId,
              msg.message_id,
              check.reasonHtml || 'Reply to a user or pass @username/ID to promote. Optional title: <code>/promote @user Mentor</code>',
              true,
              threadId
            );
            return;
          }
          const target = targetCtx.member;
          const customTitle = targetCtx.remainingArgs.join(' ').trim().slice(0, 16);
          const rightsEval = evaluatePromoteBotRights(botMember);
          const effectiveRights = rightsEval.ok
            ? rightsEval.rights
            : {
                can_manage_chat: true,
                can_delete_messages: true,
                can_manage_video_chats: true,
                can_restrict_members: true,
                can_invite_users: true,
                can_pin_messages: true,
              };

          const formatFreshCooldownHtml = (actionVerb: string, targetName: string, rem?: string | null) =>
            `Owner Override is connected, but Telegram enforces a <b>24-hour security cooldown</b> on brand-new login sessions before allowing admin edits (<code>FRESH_CHANGE_ADMINS_FORBIDDEN</code>${rem ? ` · ~${escapeHtml(rem)} left` : ''}).\n\n` +
            `<b>Do NOT disconnect or re-login</b> (that resets the 24h timer).\n` +
            `• <b>Instant fix for ${escapeHtml(targetName)} today:</b> Group Owner removes them once in <b>Group Settings → Administrators</b> using your regular Telegram app.\n` +
            `• <b>Automatic fix after cooldown:</b> Once 24h pass, <code>/${escapeHtml(actionVerb)}</code> works on all old admins automatically.`;

          if (check.ownerLocked) {
            if (ownerReady) {
              const res = await ownerMtproto.editAdmin({
                chatId,
                userId: target.user_id,
                promote: true,
                customTitle,
                rights: effectiveRights,
                targetUsername: target.username,
              });
              if (res.ok) {
                botDb.setMemberRole(chatId, target.user_id, 'administrator');
                await this.reply(
                  chatId,
                  msg.message_id,
                  `Promoted ${mentionHtml(target.user_id, target.full_name)} to <b>Administrator</b> (via Owner Override)${
                    customTitle ? ` (Title: <code>${escapeHtml(customTitle)}</code>)` : ''
                  }.`,
                  true,
                  threadId
                );
                return;
              }
              await this.reply(
                chatId,
                msg.message_id,
                res.freshCooldown
                  ? formatFreshCooldownHtml('promote', target.full_name, res.cooldownRemaining)
                  : `Owner Override /promote failed: ${escapeHtml(res.error || 'Unknown error')}`,
                true,
                threadId
              );
              return;
            }
            await this.reply(
              chatId,
              msg.message_id,
              `${mentionHtml(target.user_id, target.full_name)} is already an <b>Owner-promoted Admin 🔒</b> (` +
                `<code>can_be_edited: false</code>).\n\nTelegram's Bot API blocks any bot from editing admins promoted by the Group Owner.\n` +
                `• <b>Fix in Dashboard:</b> Link the Group Owner account under <b>CA Rose Studio → Members &amp; Settings → Owner Override</b>.\n` +
                `• <b>Or in Telegram:</b> Group Owner removes &amp; re-promotes them once via <code>/promote</code>.`,
              true,
              threadId
            );
            return;
          }
          if (!check.ok) {
            await this.reply(chatId, msg.message_id, check.reasonHtml || 'Cannot promote target.', true, threadId);
            return;
          }

          if (!rightsEval.ok && ownerReady) {
            const res = await ownerMtproto.editAdmin({
              chatId,
              userId: target.user_id,
              promote: true,
              customTitle,
              rights: effectiveRights,
              targetUsername: target.username,
            });
            if (res.ok) {
              botDb.setMemberRole(chatId, target.user_id, 'administrator');
              await this.reply(
                chatId,
                msg.message_id,
                `Promoted ${mentionHtml(target.user_id, target.full_name)} to <b>Administrator</b> (via Owner Override)${
                  customTitle ? ` (Title: <code>${escapeHtml(customTitle)}</code>)` : ''
                }.`,
                true,
                threadId
              );
              return;
            }
          }

          if (!rightsEval.ok) {
            await this.reply(chatId, msg.message_id, escapeHtml(rightsEval.reason || 'Bot lacks promotable admin rights.'), true, threadId);
            return;
          }

          try {
            await this.tgCall('promoteChatMember', {
              chat_id: chatId,
              user_id: target.user_id,
              ...rightsEval.rights,
              can_promote_members: false,
            });
          } catch (err) {
            const msgErr = err instanceof Error ? err.message : 'Promote failed';
            if (isTelegramAdminLockError(msgErr)) {
              if (ownerReady) {
                const res = await ownerMtproto.editAdmin({
                  chatId,
                  userId: target.user_id,
                  promote: true,
                  customTitle,
                  rights: effectiveRights,
                  targetUsername: target.username,
                });
                if (res.ok) {
                  botDb.setMemberRole(chatId, target.user_id, 'administrator');
                  await this.reply(
                    chatId,
                    msg.message_id,
                    `Promoted ${mentionHtml(target.user_id, target.full_name)} to <b>Administrator</b> (via Owner Override)${
                      customTitle ? ` (Title: <code>${escapeHtml(customTitle)}</code>)` : ''
                    }.`,
                    true,
                    threadId
                  );
                  return;
                }
                await this.reply(
                  chatId,
                  msg.message_id,
                  res.freshCooldown
                    ? formatFreshCooldownHtml('promote', target.full_name, res.cooldownRemaining)
                    : `Owner Override /promote failed: ${escapeHtml(res.error || msgErr)}`,
                  true,
                  threadId
                );
                return;
              }
              await this.reply(
                chatId,
                msg.message_id,
                'Telegram rejected /promote (<code>CHAT_ADMIN_REQUIRED</code>): Bots can only grant rights they themselves hold, and cannot edit Owner-promoted admins. Enable <b>Owner Override</b> in <b>CA Rose Studio → Members &amp; Settings</b> to bypass this.',
                true,
                threadId
              );
              return;
            }
            await this.reply(
              chatId,
              msg.message_id,
              formatTelegramModErrorHtml('promote', mentionHtml(target.user_id, target.full_name), err, 'promote'),
              true,
              threadId
            );
            return;
          }

          if (customTitle) {
            await this.tgCall('setChatAdministratorCustomTitle', {
              chat_id: chatId,
              user_id: target.user_id,
              custom_title: customTitle,
            }).catch(() => {});
          }

          botDb.setMemberRole(chatId, target.user_id, 'administrator');
          await this.reply(
            chatId,
            msg.message_id,
            `Promoted ${mentionHtml(target.user_id, target.full_name)} to <b>Administrator</b>${
              customTitle ? ` (Title: <code>${escapeHtml(customTitle)}</code>)` : ''
            }.`,
            true,
            threadId
          );
          return;
        }
        case 'demote': {
          const ownerReady = ownerMtproto.isReady();
          let botCanPromote = true;
          if (ownerReady) {
            if (!isGroup) {
              await this.reply(chatId, msg.message_id, 'This command works only in groups.', false, threadId);
              return;
            }
            if (!(await this.isUserAdmin(msg, undefined, 'can_promote_members'))) {
              await this.reply(chatId, msg.message_id, 'You must be an admin with Add New Admins permission to use /demote.', false, threadId);
              return;
            }
            const botMember = await this.getBotMember(chatId);
            botCanPromote = Boolean(
              botMember && (botMember.status === 'creator' || (botMember.status === 'administrator' && botMember.can_promote_members))
            );
          } else {
            if (!(await this.checkModReady(msg, 'demote', ['can_promote_members'], 'can_promote_members'))) return;
          }

          const targetCtx = await this.resolveTargetContext(msg, parsed.args);
          const check = this.verifyTarget(msg, 'demote', targetCtx);
          if (!targetCtx.member) {
            await this.reply(
              chatId,
              msg.message_id,
              check.reasonHtml || 'Reply to an admin or pass @username/ID to demote.',
              true,
              threadId
            );
            return;
          }
          const target = targetCtx.member;
          const ownerLockMsg =
            `Cannot demote ${mentionHtml(target.user_id, target.full_name)}: Telegram's server blocks any Bot API token (including Rose Bot) from editing admins promoted by the Group Owner (<code>can_be_edited: false</code>).\n\n` +
            `<b>How to demote old admins:</b>\n` +
            `1. <b>Link Owner Override (Recommended):</b> Open <b>CA Rose Studio → Members &amp; Settings → Owner Override</b> and sign in once with the Group Owner's Telegram account (or set <code>OWNER_SESSION_STRING</code>). Then <code>/demote</code> works on ALL old admins directly.\n` +
            `2. <b>Quick Telegram fix:</b> Group Owner removes them once under <b>Group Settings → Administrators</b> (anyone promoted via <code>/promote</code> afterwards can be demoted anytime).`;

          const freshCooldownMsg = (rem?: string | null) =>
            `Owner Override is connected, but Telegram blocks newly created sessions from changing admins for <b>24 hours</b> (<code>FRESH_CHANGE_ADMINS_FORBIDDEN</code>${rem ? ` · ~${escapeHtml(rem)} remaining` : ''}).\n\n` +
            `<b>Keep Owner Override connected</b> (do not disconnect/re-login or the 24h timer restarts).\n` +
            `• <b>To demote ${mentionHtml(target.user_id, target.full_name)} right now:</b> Group Owner removes them once in <b>Group Settings → Administrators</b> inside Telegram.\n` +
            `• <b>After 24 hours:</b> <code>/demote</code> will work on ALL old admins automatically.`;

          if (check.ownerLocked || (ownerReady && !botCanPromote)) {
            if (ownerReady) {
              const res = await ownerMtproto.editAdmin({
                chatId,
                userId: target.user_id,
                promote: false,
                targetUsername: target.username,
              });
              if (res.ok) {
                botDb.setMemberRole(chatId, target.user_id, 'member');
                await this.reply(
                  chatId,
                  msg.message_id,
                  `Demoted ${mentionHtml(target.user_id, target.full_name)} to regular member (via Owner Override).`,
                  true,
                  threadId
                );
                return;
              }
              await this.reply(
                chatId,
                msg.message_id,
                res.freshCooldown
                  ? freshCooldownMsg(res.cooldownRemaining)
                  : `Owner Override /demote failed: ${escapeHtml(res.error || 'Unknown error')}`,
                true,
                threadId
              );
              return;
            }
            await this.reply(chatId, msg.message_id, ownerLockMsg, true, threadId);
            return;
          }
          if (!check.ok) {
            await this.reply(chatId, msg.message_id, check.reasonHtml || 'Cannot demote target.', true, threadId);
            return;
          }

          try {
            await this.tgCall('promoteChatMember', {
              chat_id: chatId,
              user_id: target.user_id,
              can_manage_chat: false,
              can_delete_messages: false,
              can_manage_video_chats: false,
              can_restrict_members: false,
              can_promote_members: false,
              can_change_info: false,
              can_invite_users: false,
              can_pin_messages: false,
              can_manage_topics: false,
            });
          } catch (err) {
            const msgErr = err instanceof Error ? err.message : 'Demote failed';
            if (isTelegramAdminLockError(msgErr)) {
              if (ownerReady) {
                const res = await ownerMtproto.editAdmin({
                  chatId,
                  userId: target.user_id,
                  promote: false,
                  targetUsername: target.username,
                });
                if (res.ok) {
                  botDb.setMemberRole(chatId, target.user_id, 'member');
                  await this.reply(
                    chatId,
                    msg.message_id,
                    `Demoted ${mentionHtml(target.user_id, target.full_name)} to regular member (via Owner Override).`,
                    true,
                    threadId
                  );
                  return;
                }
                await this.reply(
                  chatId,
                  msg.message_id,
                  res.freshCooldown
                    ? freshCooldownMsg(res.cooldownRemaining)
                    : `Owner Override /demote failed: ${escapeHtml(res.error || msgErr)}`,
                  true,
                  threadId
                );
                return;
              }
              await this.reply(chatId, msg.message_id, ownerLockMsg, true, threadId);
              return;
            }
            await this.reply(
              chatId,
              msg.message_id,
              formatTelegramModErrorHtml('demote', mentionHtml(target.user_id, target.full_name), err, 'demote'),
              true,
              threadId
            );
            return;
          }
          botDb.setMemberRole(chatId, target.user_id, 'member');
          await this.reply(
            chatId,
            msg.message_id,
            `Demoted ${mentionHtml(target.user_id, target.full_name)} to regular member.`,
            true,
            threadId
          );
          return;
        }
        case 'warn': {
          if (!(await this.checkModReady(msg, 'warn', ['can_restrict_members'], 'can_restrict_members'))) return;
          const targetCtx = await this.resolveTargetContext(msg, parsed.args);
          const check = this.verifyTarget(msg, 'warn', targetCtx);
          if (!check.ok || !targetCtx.member) {
            await this.reply(chatId, msg.message_id, check.reasonHtml || 'Reply to a user to warn.', true, threadId);
            return;
          }
          const target = targetCtx.member;
          const warns = botDb.addWarn(chatId, target.user_id);
          const maxWarns = botDb.getGroupSettings(chatId).max_warns;
          if (warns >= maxWarns) {
            try {
              await this.tgCall('banChatMember', { chat_id: chatId, user_id: target.user_id });
            } catch (banErr) {
              await this.reply(
                chatId,
                msg.message_id,
                `${mentionHtml(target.user_id, target.full_name)} reached <b>${warns}/${maxWarns}</b> warnings, but auto-ban failed:\n${formatTelegramModErrorHtml('ban', mentionHtml(target.user_id, target.full_name), banErr, 'warn')}`,
                true,
                threadId
              );
              return;
            }
            botDb.resetWarns(chatId, target.user_id);
            botDb.setMemberActive(chatId, target.user_id, false);
            await this.reply(
              chatId,
              msg.message_id,
              `${mentionHtml(target.user_id, target.full_name)} reached ${warns}/${maxWarns} warnings and has been <b>banned</b>!`,
              true,
              threadId
            );
          } else {
            await this.reply(
              chatId,
              msg.message_id,
              `${mentionHtml(target.user_id, target.full_name)} has been warned (${warns}/${maxWarns}).`,
              true,
              threadId
            );
          }
          return;
        }
        case 'warns': {
          if (!isGroup) {
            await this.reply(chatId, msg.message_id, 'This command works only in groups.', false, threadId);
            return;
          }
          const realReply = this.getRealReplyMessage(msg);
          let uid = msg.from?.id;
          let name = msg.from ? formatFullName(msg.from) : 'User';
          if (parsed.args.length > 0 || realReply) {
            const targetCtx = await this.resolveTargetContext(msg, parsed.args);
            if (targetCtx.error) {
              await this.reply(chatId, msg.message_id, escapeHtml(targetCtx.error), true, threadId);
              return;
            }
            if (targetCtx.member) {
              uid = targetCtx.member.user_id;
              name = targetCtx.member.full_name;
            }
          }
          if (!uid) return;
          const rec = botDb.getMember(chatId, uid);
          const maxWarns = botDb.getGroupSettings(chatId).max_warns;
          await this.reply(
            chatId,
            msg.message_id,
            `${mentionHtml(uid, name)} has <b>${rec?.warns ?? 0}/${maxWarns}</b> warnings.`,
            true,
            threadId
          );
          return;
        }
        case 'resetwarns': {
          if (!(await this.checkModReady(msg, 'resetwarns', ['can_restrict_members']))) return;
          const targetCtx = await this.resolveTargetContext(msg, parsed.args);
          if (targetCtx.error) {
            await this.reply(chatId, msg.message_id, escapeHtml(targetCtx.error), true, threadId);
            return;
          }
          const target = targetCtx.member;
          if (!target) {
            await this.reply(chatId, msg.message_id, 'Reply to a user or provide ID/@username to reset warnings.', false, threadId);
            return;
          }
          botDb.resetWarns(chatId, target.user_id);
          await this.reply(
            chatId,
            msg.message_id,
            `Warnings reset for ${mentionHtml(target.user_id, target.full_name)}.`,
            true,
            threadId
          );
          return;
        }
        case 'del': {
          if (!(await this.checkModReady(msg, 'del', ['can_delete_messages'], 'can_delete_messages'))) return;
          const realReply = this.getRealReplyMessage(msg);
          if (!realReply) {
            await this.reply(chatId, msg.message_id, 'Reply to a message to delete it.', false, threadId);
            return;
          }
          try {
            await this.tgCall('deleteMessage', {
              chat_id: chatId,
              message_id: realReply.message_id,
            });
            await this.tgCall('deleteMessage', {
              chat_id: chatId,
              message_id: msg.message_id,
            }).catch(() => {});
          } catch (delErr) {
            await this.reply(
              chatId,
              msg.message_id,
              formatTelegramModErrorHtml('delete', null, delErr, 'del'),
              true,
              threadId
            );
          }
          return;
        }
        case 'pin': {
          if (!(await this.checkModReady(msg, 'pin', ['can_pin_messages'], 'can_pin_messages'))) return;
          const realReply = this.getRealReplyMessage(msg);
          if (!realReply) {
            await this.reply(chatId, msg.message_id, 'Reply to a message to pin it.', false, threadId);
            return;
          }
          const loud = parsed.args[0]?.toLowerCase() === 'loud' || parsed.args[0]?.toLowerCase() === 'notify';
          try {
            await this.tgCall('pinChatMessage', {
              chat_id: chatId,
              message_id: realReply.message_id,
              disable_notification: !loud,
            });
            await this.reply(chatId, msg.message_id, 'Pinned message successfully.', false, threadId);
          } catch (pinErr) {
            await this.reply(
              chatId,
              msg.message_id,
              formatTelegramModErrorHtml('pin', null, pinErr, 'pin'),
              true,
              threadId
            );
          }
          return;
        }
        case 'unpin': {
          if (!(await this.checkModReady(msg, 'unpin', ['can_pin_messages'], 'can_pin_messages'))) return;
          const realReply = this.getRealReplyMessage(msg);
          try {
            await this.tgCall('unpinChatMessage', {
              chat_id: chatId,
              ...(realReply ? { message_id: realReply.message_id } : {}),
            });
            await this.reply(chatId, msg.message_id, 'Unpinned successfully.', false, threadId);
          } catch (unpinErr) {
            await this.reply(
              chatId,
              msg.message_id,
              formatTelegramModErrorHtml('unpin', null, unpinErr, 'unpin'),
              true,
              threadId
            );
          }
          return;
        }
        case 'setwelcome': {
          if (!isGroup || !(await this.isUserAdmin(msg))) {
            await this.reply(chatId, msg.message_id, 'Only admins can set the welcome message.', false, threadId);
            return;
          }
          if (!parsed.rawArgs) {
            await this.reply(
              chatId,
              msg.message_id,
              'Usage: /setwelcome Hello {name}! How are you doing? Welcome to {chat_title}!',
              false,
              threadId
            );
            return;
          }
          botDb.updateGroupSettings(chatId, { welcome_text: parsed.rawArgs });
          await this.reply(chatId, msg.message_id, 'Welcome message updated!', false, threadId);
          return;
        }
        case 'welcome': {
          if (!isGroup || !(await this.isUserAdmin(msg))) {
            await this.reply(chatId, msg.message_id, 'Only admins can toggle welcome messages.', false, threadId);
            return;
          }
          const arg = parsed.args[0]?.toLowerCase();
          if (arg !== 'on' && arg !== 'off') {
            await this.reply(chatId, msg.message_id, 'Usage: /welcome on or /welcome off', false, threadId);
            return;
          }
          const enabled = arg === 'on';
          botDb.updateGroupSettings(chatId, { welcome_enabled: enabled });
          await this.reply(chatId, msg.message_id, `Welcome messages turned <b>${enabled ? 'ON' : 'OFF'}</b>.`, true, threadId);
          return;
        }
        case 'setrules': {
          if (!isGroup || !(await this.isUserAdmin(msg))) {
            await this.reply(chatId, msg.message_id, 'Only admins can set rules.', false, threadId);
            return;
          }
          if (!parsed.rawArgs) {
            await this.reply(chatId, msg.message_id, 'Usage: /setrules No spam, stay focused on CA prep!', false, threadId);
            return;
          }
          botDb.updateGroupSettings(chatId, { rules_text: parsed.rawArgs });
          await this.reply(chatId, msg.message_id, 'Group rules updated!', false, threadId);
          return;
        }
        case 'rules': {
          if (!isGroup) return;
          const rules = botDb.getGroupSettings(chatId).rules_text;
          await this.reply(chatId, msg.message_id, `<b>Group Rules:</b>\n${escapeHtml(rules)}`, true, threadId);
          return;
        }
        default:
          return;
      }
    }

    const isPrivate = msg.chat.type === 'private';
    const realReply = this.getRealReplyMessage(msg);
    const replyFromBot = Boolean(realReply?.from?.id === this.botId);
    const isReplyToCaBot = Boolean(
      replyFromBot &&
        realReply &&
        botDb.isBotCaMessage(chatId, realReply.message_id)
    );
    if (!isBotMentionedOrReplied(rawText, this.botUsername, isReplyToCaBot, isPrivate)) {
      return;
    }

    const senderUid = msg.from?.id ?? chatId;
    let cleaned = stripBotMention(rawText, this.botUsername);
    if (realReply && realReply.from?.id !== this.botId) {
      const refText = (realReply.text || realReply.caption || '').trim();
      if (refText) {
        cleaned = `Referenced message: ${refText}\n\nUser request: ${cleaned}`.trim();
      }
    }

    const audioAttachment = msg.voice || msg.audio || realReply?.voice || realReply?.audio;
    if (!audioAttachment && isCasualAckOrGreeting(cleaned)) {
      return;
    }

    let audioBase64: string | undefined;
    let audioMime: string | undefined;

    if (audioAttachment) {
      if ((audioAttachment.file_size ?? 0) > 20 * 1024 * 1024) {
        await this.reply(chatId, msg.message_id, 'Audio file is larger than 20 MB. Please send a shorter clip.', false, threadId);
        return;
      }
      const fileInfo = await this.tgCall<{ file_path: string }>('getFile', { file_id: audioAttachment.file_id });
      const fileResp = await fetch(`https://api.telegram.org/file/bot${this.token}/${fileInfo.file_path}`, {
        signal: AbortSignal.timeout(20000),
      });
      if (!fileResp.ok) {
        throw new Error(`Audio download failed (HTTP ${fileResp.status}).`);
      }
      const buf = Buffer.from(await fileResp.arrayBuffer());
      audioBase64 = buf.toString('base64');
      audioMime = audioAttachment.mime_type || (msg.voice ? 'audio/ogg' : 'audio/mpeg');
    }

    if (!cleaned && !audioBase64) {
      if (!isPrivate && botDb.hasCaNoticeSent(chatId, senderUid)) {
        return;
      }
      botDb.markCaNoticeSent(chatId, senderUid);
      await this.reply(chatId, msg.message_id, CA_ONE_TIME_NOTICE, false, threadId);
      return;
    }

    this.lastEvent = `CA AI request from ${msg.from?.username || msg.chat.title || chatId}`;

    await this.tgCall('sendChatAction', {
      chat_id: chatId,
      action: 'typing',
      ...(threadId ? { message_thread_id: threadId } : {}),
    }).catch(() => {});

    let answer: string;
    try {
      answer = await withTimeout(
        askGeminiCA({ promptText: cleaned, audioBase64, audioMime }),
        48000,
        'CA AI response'
      );
    } catch (aiErr) {
      const errMsg = aiErr instanceof Error ? aiErr.message : 'CA AI request failed.';
      await this.reply(
        chatId,
        msg.message_id,
        isTransientTimeoutOrNetworkError(aiErr)
          ? 'CA AI is busy or took too long right now. Please resend your question.'
          : errMsg,
        false,
        threadId
      ).catch(() => {});
      return;
    }
    if (isNonCaSentinelOrRefusal(answer)) {
      if (!isPrivate && botDb.hasCaNoticeSent(chatId, senderUid)) {
        return;
      }
      botDb.markCaNoticeSent(chatId, senderUid);
      await this.reply(chatId, msg.message_id, CA_ONE_TIME_NOTICE, false, threadId);
      return;
    }

    const sentMsgId = await this.reply(chatId, msg.message_id, answer, false, threadId);
    if (sentMsgId) {
      botDb.markBotCaMessage(chatId, sentMsgId);
    }
  }
}

import { Api, TelegramClient, extensions, sessions } from 'telegram';
import {
  buildMtprotoAdminRights,
  computeSessionCooldownRemaining,
  isFreshSessionAdminError,
  isTransientTimeoutOrNetworkError,
  withTimeout,
  type PromoteRightsEvaluation,
} from '../lib/botLogic';
import type { OwnerOverrideStatus } from '../types';
import { botDb } from './db';

const CONFIG_KEYS = {
  apiId: 'telegram_api_id',
  apiHash: 'telegram_api_hash',
  session: 'owner_session_string',
  label: 'owner_account_label',
  userId: 'owner_user_id',
  connectedAt: 'owner_connected_at',
} as const;

interface PendingLoginState {
  client: TelegramClient;
  apiId: number;
  apiHash: string;
  phoneNumber: string;
  phoneCodeHash: string;
  awaitingPassword: boolean;
  expiresAt: number;
}

function createSilentLogger(): extensions.Logger {
  const logger = new extensions.Logger('error' as never);
  return logger;
}

function maskPhone(phone: string): string {
  const clean = phone.trim();
  if (clean.length <= 5) return '***';
  return `${clean.slice(0, 3)}••••${clean.slice(-3)}`;
}

function formatOwnerUserLabel(me: Api.User): string {
  const fullName = [me.firstName, me.lastName].filter(Boolean).join(' ').trim() || 'Telegram Owner';
  return me.username ? `${fullName} (@${me.username})` : fullName;
}

function extractRpcMessage(err: unknown): string {
  if (!err) return 'Unknown MTProto error';
  if (typeof err === 'object') {
    const rec = err as { errorMessage?: string; message?: string };
    if (rec.errorMessage) return rec.errorMessage;
    if (rec.message) return rec.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export class OwnerMtprotoManager {
  private client: TelegramClient | null = null;
  private apiId = 0;
  private apiHash = '';
  private sessionString = '';
  private connected = false;
  private accountLabel: string | null = null;
  private userId: string | null = null;
  private connectedAt: string | null = null;
  private lastError: string | null = null;
  private pendingLogin: PendingLoginState | null = null;

  public getStatus(): OwnerOverrideStatus {
    this.pruneExpiredPending();
    const configured = Boolean(this.apiId > 0 && this.apiHash && this.sessionString);
    const cooldown = computeSessionCooldownRemaining(this.connectedAt);
    return {
      configured,
      connected: this.connected && Boolean(this.client),
      accountLabel: this.accountLabel,
      userId: this.userId,
      connectedAt: this.connectedAt,
      freshCooldownRemaining: cooldown.inCooldown ? cooldown.label : null,
      lastError: this.lastError,
      pendingLogin: {
        active: Boolean(this.pendingLogin),
        phoneMasked: this.pendingLogin ? maskPhone(this.pendingLogin.phoneNumber) : null,
        awaitingPassword: Boolean(this.pendingLogin?.awaitingPassword),
      },
    };
  }

  public isReady(): boolean {
    return this.connected && Boolean(this.client);
  }

  private pruneExpiredPending(): void {
    if (this.pendingLogin && Date.now() > this.pendingLogin.expiresAt) {
      void this.pendingLogin.client.disconnect().catch(() => {});
      this.pendingLogin = null;
    }
  }

  private loadEffectiveCredentials(): { apiId: number; apiHash: string; sessionString: string } {
    const envApiId = Number((process.env.TELEGRAM_API_ID || '').trim());
    const envApiHash = (process.env.TELEGRAM_API_HASH || '').trim();
    const envSession = (process.env.OWNER_SESSION_STRING || '').trim();

    if (Number.isInteger(envApiId) && envApiId > 0 && envApiHash && envSession) {
      return { apiId: envApiId, apiHash: envApiHash, sessionString: envSession };
    }

    const dbApiId = Number((botDb.getConfig(CONFIG_KEYS.apiId) || '').trim());
    const dbApiHash = (botDb.getConfig(CONFIG_KEYS.apiHash) || '').trim();
    const dbSession = (botDb.getConfig(CONFIG_KEYS.session) || '').trim();

    if (Number.isInteger(dbApiId) && dbApiId > 0 && dbApiHash && dbSession) {
      return { apiId: dbApiId, apiHash: dbApiHash, sessionString: dbSession };
    }

    return { apiId: 0, apiHash: '', sessionString: '' };
  }

  private initRetryTimer: ReturnType<typeof setTimeout> | null = null;

  public async initFromSavedConfig(retryAttempt = 0): Promise<void> {
    const creds = this.loadEffectiveCredentials();
    if (!creds.apiId || !creds.apiHash || !creds.sessionString) {
      this.accountLabel = botDb.getConfig(CONFIG_KEYS.label);
      this.userId = botDb.getConfig(CONFIG_KEYS.userId);
      return;
    }

    if (this.initRetryTimer) {
      clearTimeout(this.initRetryTimer);
      this.initRetryTimer = null;
    }

    try {
      await withTimeout(
        this.activateClient(creds.apiId, creds.apiHash, creds.sessionString, false),
        18000,
        'Owner Override startup'
      );
      console.log(`[OwnerMtproto] Owner Override active as ${this.accountLabel || this.userId}`);
    } catch (err) {
      this.lastError = extractRpcMessage(err);
      this.connected = false;
      console.error('[OwnerMtproto] Saved session init failed:', this.lastError);
      if (retryAttempt < 2 && isTransientTimeoutOrNetworkError(err)) {
        this.initRetryTimer = setTimeout(() => {
          this.initRetryTimer = null;
          void this.initFromSavedConfig(retryAttempt + 1);
        }, 15000);
        this.initRetryTimer.unref();
      }
    }
  }

  private async activateClient(
    apiId: number,
    apiHash: string,
    sessionString: string,
    persist: boolean
  ): Promise<{ accountLabel: string; userId: string }> {
    const nextClient = new TelegramClient(
      new sessions.StringSession(sessionString.trim()),
      apiId,
      apiHash,
      {
        connectionRetries: 3,
        autoReconnect: true,
        timeout: 15,
        baseLogger: createSilentLogger(),
      }
    );

    await withTimeout(nextClient.connect(), 15000, 'Owner Override connect');
    const authorized = await withTimeout(nextClient.isUserAuthorized(), 10000, 'Owner Override auth check');
    if (!authorized) {
      await nextClient.disconnect().catch(() => {});
      throw new Error('Session string is not authorized or has expired.');
    }

    const me = (await withTimeout(nextClient.getMe(), 10000, 'Owner Override getMe')) as Api.User;
    if (me.bot) {
      await nextClient.disconnect().catch(() => {});
      throw new Error('Owner Override must use a Telegram user (Group Owner) account, not a bot session.');
    }

    const savedSession = String((nextClient.session as sessions.StringSession).save() || sessionString).trim();
    const label = formatOwnerUserLabel(me);
    const uidStr = String(me.id);

    if (this.client && this.client !== nextClient) {
      await this.client.disconnect().catch(() => {});
    }

    this.client = nextClient;
    this.apiId = apiId;
    this.apiHash = apiHash;
    this.sessionString = savedSession;
    this.connected = true;
    this.accountLabel = label;
    this.userId = uidStr;
    this.lastError = null;

    if (persist) {
      const connectedIso = new Date().toISOString();
      this.connectedAt = connectedIso;
      botDb.setConfig(CONFIG_KEYS.apiId, String(apiId));
      botDb.setConfig(CONFIG_KEYS.apiHash, apiHash);
      botDb.setConfig(CONFIG_KEYS.session, savedSession);
      botDb.setConfig(CONFIG_KEYS.label, label);
      botDb.setConfig(CONFIG_KEYS.userId, uidStr);
      botDb.setConfig(CONFIG_KEYS.connectedAt, connectedIso);
    } else {
      let existingConnectedAt = botDb.getConfig(CONFIG_KEYS.connectedAt);
      if (!existingConnectedAt) {
        existingConnectedAt = new Date().toISOString();
        botDb.setConfig(CONFIG_KEYS.connectedAt, existingConnectedAt);
      }
      this.connectedAt = existingConnectedAt;
    }

    return { accountLabel: label, userId: uidStr };
  }

  public async startCodeLogin(params: {
    apiId: number;
    apiHash: string;
    phoneNumber: string;
  }): Promise<{ ok: true; isCodeViaApp: boolean; phoneMasked: string }> {
    const apiId = Number(params.apiId);
    const apiHash = params.apiHash.trim();
    let phoneNumber = params.phoneNumber.trim().replace(/\s+/g, '');
    if (phoneNumber && !phoneNumber.startsWith('+')) {
      phoneNumber = `+${phoneNumber}`;
    }

    if (!Number.isInteger(apiId) || apiId <= 0) {
      throw new Error('Valid numeric Telegram API ID from my.telegram.org is required.');
    }
    if (!apiHash || apiHash.length < 16) {
      throw new Error('Valid Telegram API Hash from my.telegram.org is required.');
    }
    if (!/^\+\d{7,15}$/.test(phoneNumber)) {
      throw new Error('Enter a valid phone number in international format, e.g. +919876543210.');
    }

    if (this.pendingLogin) {
      await this.pendingLogin.client.disconnect().catch(() => {});
      this.pendingLogin = null;
    }

    const tempClient = new TelegramClient(new sessions.StringSession(''), apiId, apiHash, {
      connectionRetries: 3,
      autoReconnect: true,
      timeout: 15,
      baseLogger: createSilentLogger(),
    });

    try {
      await withTimeout(tempClient.connect(), 15000, 'Owner login connect');
      const { phoneCodeHash, isCodeViaApp } = await tempClient.sendCode(
        { apiId, apiHash },
        phoneNumber
      );

      this.pendingLogin = {
        client: tempClient,
        apiId,
        apiHash,
        phoneNumber,
        phoneCodeHash,
        awaitingPassword: false,
        expiresAt: Date.now() + 10 * 60 * 1000,
      };
      this.lastError = null;
      return { ok: true, isCodeViaApp, phoneMasked: maskPhone(phoneNumber) };
    } catch (err) {
      await tempClient.disconnect().catch(() => {});
      const msg = extractRpcMessage(err);
      this.lastError = msg;
      throw new Error(`Telegram login code request failed: ${msg}`);
    }
  }

  public async completeCodeLogin(params: {
    phoneCode?: string;
    password?: string;
  }): Promise<{
    ok: boolean;
    requiresPassword?: boolean;
    message: string;
    status: OwnerOverrideStatus;
  }> {
    this.pruneExpiredPending();
    const pending = this.pendingLogin;
    if (!pending) {
      throw new Error('No active login session found. Request a verification code first.');
    }

    const code = (params.phoneCode || '').trim();
    const password = (params.password || '').trim();

    if (!pending.awaitingPassword && !code) {
      throw new Error('Please enter the verification code sent by Telegram.');
    }

    try {
      if (!pending.awaitingPassword) {
        try {
          await pending.client.invoke(
            new Api.auth.SignIn({
              phoneNumber: pending.phoneNumber,
              phoneCodeHash: pending.phoneCodeHash,
              phoneCode: code,
            })
          );
        } catch (err) {
          const msg = extractRpcMessage(err);
          if (msg.includes('SESSION_PASSWORD_NEEDED')) {
            pending.awaitingPassword = true;
            if (!password) {
              return {
                ok: false,
                requiresPassword: true,
                message: 'Telegram 2FA password is enabled on this account. Enter your 2FA password to finish.',
                status: this.getStatus(),
              };
            }
          } else {
            throw err;
          }
        }
      }

      if (pending.awaitingPassword) {
        if (!password) {
          return {
            ok: false,
            requiresPassword: true,
            message: 'Please enter your Telegram Two-Step Verification (2FA) password.',
            status: this.getStatus(),
          };
        }
        let twoFaErr: Error | null = null;
        await pending.client.signInWithPassword(
          { apiId: pending.apiId, apiHash: pending.apiHash },
          {
            password: async () => password,
            onError: async (err) => {
              twoFaErr = err;
              return true;
            },
          }
        );
        if (twoFaErr) {
          throw twoFaErr;
        }
      }

      const me = (await pending.client.getMe()) as Api.User;
      const savedSession = String((pending.client.session as sessions.StringSession).save() || '').trim();
      const label = formatOwnerUserLabel(me);
      const uidStr = String(me.id);

      if (this.client && this.client !== pending.client) {
        await this.client.disconnect().catch(() => {});
      }

      const connectedIso = new Date().toISOString();
      this.client = pending.client;
      this.apiId = pending.apiId;
      this.apiHash = pending.apiHash;
      this.sessionString = savedSession;
      this.connected = true;
      this.accountLabel = label;
      this.userId = uidStr;
      this.connectedAt = connectedIso;
      this.lastError = null;
      this.pendingLogin = null;

      botDb.setConfig(CONFIG_KEYS.apiId, String(this.apiId));
      botDb.setConfig(CONFIG_KEYS.apiHash, this.apiHash);
      botDb.setConfig(CONFIG_KEYS.session, this.sessionString);
      botDb.setConfig(CONFIG_KEYS.label, label);
      botDb.setConfig(CONFIG_KEYS.userId, uidStr);
      botDb.setConfig(CONFIG_KEYS.connectedAt, connectedIso);

      return {
        ok: true,
        message: `Connected Owner Override as ${label}. Note: Telegram enforces a 24h security cooldown on newly created sessions before editing old Owner-promoted admins — keep this session connected.`,
        status: this.getStatus(),
      };
    } catch (err) {
      const msg = extractRpcMessage(err);
      this.lastError = msg;
      throw new Error(`Verification failed: ${msg}`);
    }
  }

  public async connectWithSessionString(params: {
    apiId: number;
    apiHash: string;
    sessionString: string;
  }): Promise<{ ok: true; message: string; status: OwnerOverrideStatus }> {
    const apiId = Number(params.apiId);
    const apiHash = params.apiHash.trim();
    const sessionString = params.sessionString.trim();

    if (!Number.isInteger(apiId) || apiId <= 0) {
      throw new Error('Valid numeric Telegram API ID from my.telegram.org is required.');
    }
    if (!apiHash || apiHash.length < 16) {
      throw new Error('Valid Telegram API Hash from my.telegram.org is required.');
    }
    if (!sessionString || sessionString.length < 20) {
      throw new Error('Enter a valid OWNER_SESSION_STRING.');
    }

    const res = await this.activateClient(apiId, apiHash, sessionString, true);
    return {
      ok: true,
      message: `Connected Owner Override as ${res.accountLabel}.`,
      status: this.getStatus(),
    };
  }

  public async disconnect(): Promise<OwnerOverrideStatus> {
    if (this.pendingLogin) {
      await this.pendingLogin.client.disconnect().catch(() => {});
      this.pendingLogin = null;
    }
    if (this.client) {
      await this.client.disconnect().catch(() => {});
      this.client = null;
    }
    this.apiId = 0;
    this.apiHash = '';
    this.sessionString = '';
    this.connected = false;
    this.accountLabel = null;
    this.userId = null;
    this.connectedAt = null;
    this.lastError = null;

    botDb.deleteConfig(CONFIG_KEYS.apiId);
    botDb.deleteConfig(CONFIG_KEYS.apiHash);
    botDb.deleteConfig(CONFIG_KEYS.session);
    botDb.deleteConfig(CONFIG_KEYS.label);
    botDb.deleteConfig(CONFIG_KEYS.userId);
    botDb.deleteConfig(CONFIG_KEYS.connectedAt);

    return this.getStatus();
  }

  private async resolveChannelEntity(client: TelegramClient, chatId: number): Promise<Api.TypeInputPeer> {
    try {
      return await client.getInputEntity(chatId);
    } catch {
      await client.getDialogs({ limit: 80 });
      return await client.getInputEntity(chatId);
    }
  }

  private async resolveTargetUserEntity(
    client: TelegramClient,
    channelEntity: Api.TypeInputPeer,
    userId: number,
    targetUsername?: string | null
  ): Promise<Api.TypeInputPeer> {
    try {
      return await client.getInputEntity(userId);
    } catch {
      // ignore and try username / channel admins lookup
    }

    if (targetUsername) {
      try {
        return await client.getInputEntity(`@${targetUsername.replace(/^@/, '')}`);
      } catch {
        // ignore and warm participants
      }
    }

    try {
      const admins = await client.getParticipants(channelEntity, {
        filter: new Api.ChannelParticipantsAdmins(),
        limit: 200,
      });
      const matched = admins.find((u) => Number(u.id) === userId);
      if (matched) {
        return await client.getInputEntity(matched);
      }
    } catch {
      // ignore
    }

    return await client.getInputEntity(userId);
  }

  public async editAdmin(params: {
    chatId: number;
    userId: number;
    promote: boolean;
    customTitle?: string;
    rights?: PromoteRightsEvaluation['rights'];
    targetUsername?: string | null;
  }): Promise<{ ok: boolean; error?: string; freshCooldown?: boolean; cooldownRemaining?: string | null }> {
    if (!this.client || !this.connected) {
      return { ok: false, error: 'Owner Override MTProto session is not connected.' };
    }

    try {
      if (!this.client.connected) {
        await withTimeout(this.client.connect(), 10000, 'Owner MTProto reconnect');
      }

      const channelEntity = await withTimeout(
        this.resolveChannelEntity(this.client, params.chatId),
        10000,
        'Resolve group entity'
      );
      const userEntity = await withTimeout(
        this.resolveTargetUserEntity(
          this.client,
          channelEntity,
          params.userId,
          params.targetUsername
        ),
        10000,
        'Resolve target user'
      );

      const flags = buildMtprotoAdminRights(params.promote, params.rights);
      const adminRights = new Api.ChatAdminRights(flags);
      const rank = params.promote ? (params.customTitle || '').trim().slice(0, 16) : '';

      await withTimeout(
        this.client.invoke(
          new Api.channels.EditAdmin({
            channel: channelEntity,
            userId: userEntity,
            adminRights,
            rank,
          })
        ),
        12000,
        'Owner MTProto editAdmin'
      );

      this.lastError = null;
      return { ok: true };
    } catch (err) {
      const msg = extractRpcMessage(err);
      this.lastError = msg;
      if (isFreshSessionAdminError(msg)) {
        if (!this.connectedAt) {
          this.connectedAt = new Date().toISOString();
          botDb.setConfig(CONFIG_KEYS.connectedAt, this.connectedAt);
        }
        const cooldown = computeSessionCooldownRemaining(this.connectedAt);
        return {
          ok: false,
          freshCooldown: true,
          cooldownRemaining: cooldown.label,
          error:
            `Telegram's server blocks brand-new login sessions from changing admins for 24 hours (${msg}).`,
        };
      }
      if (msg.includes('CHAT_ADMIN_REQUIRED') || msg.includes('RIGHT_FORBIDDEN')) {
        return {
          ok: false,
          error:
            `Telegram returned ${msg} for the connected Owner account (${this.accountLabel || this.userId}). Ensure that logged-in account is the actual Group Creator / Owner of this group.`,
        };
      }
      return { ok: false, error: msg };
    }
  }

  public async syncGroupParticipants(chatId: number): Promise<{
    ok: boolean;
    syncedCount: number;
    error?: string;
  }> {
    if (!this.client || !this.connected) {
      return { ok: false, syncedCount: 0, error: 'Owner Override MTProto session is not connected.' };
    }

    try {
      if (!this.client.connected) {
        await withTimeout(this.client.connect(), 8000, 'Owner MTProto reconnect');
      }

      const channelEntity = await withTimeout(
        this.resolveChannelEntity(this.client, chatId),
        8000,
        'Resolve group entity'
      );
      const participants = await withTimeout(
        this.client.getParticipants(channelEntity, { limit: 2000 }),
        9000,
        'Fetch group participants'
      );
      const activeHumanIds = new Set<number>();
      let syncedCount = 0;

      for (const participant of participants) {
        if (!participant || participant.bot || participant.deleted) {
          continue;
        }
        const uid = Number(participant.id);
        if (!Number.isFinite(uid) || uid <= 0) {
          continue;
        }
        const fullName =
          [participant.firstName, participant.lastName].filter(Boolean).join(' ').trim() ||
          participant.username ||
          'Member';

        const participantMeta = (participant as { participant?: { className?: string } }).participant;
        const className = participantMeta?.className || '';
        const role =
          className === 'ChannelParticipantCreator' || className === 'ChatParticipantCreator'
            ? 'owner'
            : className === 'ChannelParticipantAdmin' || className === 'ChatParticipantAdmin'
              ? 'administrator'
              : undefined;

        botDb.upsertMember({
          chatId,
          userId: uid,
          username: participant.username ?? null,
          fullName,
          ...(role ? { role } : {}),
          isBot: false,
          isActive: true,
        });
        activeHumanIds.add(uid);
        syncedCount += 1;
      }

      // If full participant list returned (< 2000), mark departed humans inactive
      if (participants.length > 0 && participants.length < 2000) {
        for (const existing of botDb.getMembers(chatId)) {
          if (!existing.is_bot && existing.is_active && !activeHumanIds.has(existing.user_id)) {
            botDb.setMemberActive(chatId, existing.user_id, false);
          }
        }
      }

      return { ok: true, syncedCount };
    } catch (err) {
      return { ok: false, syncedCount: 0, error: extractRpcMessage(err) };
    }
  }

  public async sendGroupHtmlMessage(params: {
    chatId: number;
    htmlText: string;
    replyToMessageId?: number;
  }): Promise<{ ok: boolean; error?: string }> {
    if (!this.client || !this.connected) {
      return { ok: false, error: 'Owner Override MTProto session is not connected.' };
    }
    try {
      if (!this.client.connected) {
        await withTimeout(this.client.connect(), 8000, 'Owner MTProto reconnect');
      }
      const channelEntity = await withTimeout(
        this.resolveChannelEntity(this.client, params.chatId),
        8000,
        'Resolve group entity'
      );
      await withTimeout(
        this.client.sendMessage(channelEntity, {
          message: params.htmlText,
          parseMode: 'html',
          ...(params.replyToMessageId ? { replyTo: params.replyToMessageId } : {}),
        }),
        10000,
        'Owner MTProto sendMessage'
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, error: extractRpcMessage(err) };
    }
  }

  public async resolveUsernameInChat(
    chatId: number,
    username: string
  ): Promise<{ userId: number; fullName: string; username: string | null; isBot: boolean } | null> {
    if (!this.client || !this.connected) {
      return null;
    }
    const clean = username.trim().replace(/^@/, '').toLowerCase();
    if (!clean) return null;

    try {
      if (!this.client.connected) {
        await withTimeout(this.client.connect(), 6000, 'Owner MTProto reconnect');
      }

      try {
        const entity = await withTimeout(this.client.getEntity(`@${clean}`), 6000, 'Resolve @username');
        if (entity && entity instanceof Api.User) {
          const uid = Number(entity.id);
          if (Number.isFinite(uid) && uid > 0) {
            const fullName =
              [entity.firstName, entity.lastName].filter(Boolean).join(' ').trim() ||
              entity.username ||
              clean;
            return {
              userId: uid,
              fullName,
              username: entity.username ?? clean,
              isBot: Boolean(entity.bot),
            };
          }
        }
      } catch {
        // fallback to searching group participants directly
      }

      const channelEntity = await withTimeout(
        this.resolveChannelEntity(this.client, chatId),
        6000,
        'Resolve group entity'
      );
      const matches = await withTimeout(
        this.client.getParticipants(channelEntity, { search: clean, limit: 25 }),
        6000,
        'Search group participants'
      );
      for (const p of matches) {
        if ((p.username || '').toLowerCase() === clean) {
          const uid = Number(p.id);
          if (Number.isFinite(uid) && uid > 0) {
            const fullName =
              [p.firstName, p.lastName].filter(Boolean).join(' ').trim() ||
              p.username ||
              clean;
            return {
              userId: uid,
              fullName,
              username: p.username ?? clean,
              isBot: Boolean(p.bot),
            };
          }
        }
      }
      return null;
    } catch {
      return null;
    }
  }
}

export const ownerMtproto = new OwnerMtprotoManager();

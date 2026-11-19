import { DatabaseSync } from 'node:sqlite';
import type { ChatMessage, GroupMember, GroupSettings, MemberRole } from '../types';
import { BOT_USER_ID, BOT_USERNAME_DEFAULT, DEFAULT_WELCOME_TEXT } from '../lib/botLogic';

export const DEFAULT_CHAT_ID = -1001849203412;

const DB_PATH = process.env.DB_PATH?.trim() || 'bot_data.db';

function nowUtc(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi} UTC`;
}

export class BotDatabase {
  private db: DatabaseSync;

  constructor(dbPath: string = DB_PATH) {
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
    this.seedIfEmpty();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS group_settings (
        chat_id INTEGER PRIMARY KEY,
        chat_title TEXT DEFAULT 'ICAI CA Final & Inter Study Hub',
        welcome_enabled INTEGER DEFAULT 1,
        welcome_text TEXT DEFAULT 'Hello {name}! How are you doing? Welcome to {chat_title}!',
        rules_text TEXT DEFAULT '1. Keep discussions strictly focused on CA Foundation, Inter, Final, or Articleship. 2. No spam or forwarded promotions. 3. Tag @CA_Rose_Bot for ICAI doubts & voice evaluations.',
        max_warns INTEGER DEFAULT 3,
        pinned_message_id INTEGER DEFAULT NULL
      );

      CREATE TABLE IF NOT EXISTS members (
        chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        username TEXT,
        full_name TEXT NOT NULL,
        role TEXT DEFAULT 'member',
        is_bot INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        is_muted INTEGER DEFAULT 0,
        muted_until TEXT DEFAULT NULL,
        msg_count INTEGER DEFAULT 0,
        warns INTEGER DEFAULT 0,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        avatar_url TEXT DEFAULT NULL,
        PRIMARY KEY (chat_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        sender_id INTEGER NOT NULL,
        sender_name TEXT NOT NULL,
        sender_username TEXT,
        sender_role TEXT DEFAULT 'member',
        is_bot INTEGER DEFAULT 0,
        text TEXT NOT NULL,
        reply_to_id INTEGER DEFAULT NULL,
        reply_to_snippet TEXT DEFAULT NULL,
        audio_name TEXT DEFAULT NULL,
        audio_mime TEXT DEFAULT NULL,
        message_type TEXT DEFAULT 'chat',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ca_notice_log (
        chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        last_notified_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS bot_ca_messages (
        chat_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, message_id)
      );

      CREATE TABLE IF NOT EXISTS bot_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    this.db
      .prepare(
        `UPDATE group_settings SET welcome_text = ? WHERE welcome_text IN (?, ?, ?)`
      )
      .run(
        DEFAULT_WELCOME_TEXT,
        'Welcome {mention} to {chat_title}! Stay focused on your ICAI preparation.',
        'Welcome {mention} to {chat_title}!',
        'Hello {mention}! How are you doing? Welcome to {chat_title}!'
      );
  }

  public seedIfEmpty(): void {
    const existingGroup = this.db
      .prepare('SELECT chat_id FROM group_settings WHERE chat_id = ?')
      .get(DEFAULT_CHAT_ID);

    if (existingGroup) {
      return;
    }

    const now = nowUtc();
    this.db
      .prepare('INSERT INTO group_settings (chat_id) VALUES (?)')
      .run(DEFAULT_CHAT_ID);

    const seedMembers: Array<{
      user_id: number;
      username: string;
      full_name: string;
      role: MemberRole;
      is_bot: number;
      msg_count: number;
      warns: number;
      avatar_url: string | null;
    }> = [
      {
        user_id: BOT_USER_ID,
        username: BOT_USERNAME_DEFAULT,
        full_name: 'CA Rose Guider',
        role: 'administrator',
        is_bot: 1,
        msg_count: 14,
        warns: 0,
        avatar_url: '/src/assets/images/avatar_ca_bot_1794835035532.jpg',
      },
      {
        user_id: 1001001,
        username: 'ca_meera',
        full_name: 'Meera Nair, FCA',
        role: 'owner',
        is_bot: 0,
        msg_count: 28,
        warns: 0,
        avatar_url: '/src/assets/images/avatar_ca_mentor_1794835036704.jpg',
      },
      {
        user_id: 1001002,
        username: 'arjun_mod',
        full_name: 'Arjun Mehta',
        role: 'administrator',
        is_bot: 0,
        msg_count: 19,
        warns: 0,
        avatar_url: '/src/assets/images/avatar_student_one_1794835037680.jpg',
      },
      {
        user_id: 1001003,
        username: 'rohan_ca',
        full_name: 'Rohan Verma',
        role: 'member',
        is_bot: 0,
        msg_count: 11,
        warns: 1,
        avatar_url: '/src/assets/images/avatar_student_one_1794835037680.jpg',
      },
      {
        user_id: 1001004,
        username: 'priya_articleship',
        full_name: 'Priya Sharma',
        role: 'member',
        is_bot: 0,
        msg_count: 16,
        warns: 0,
        avatar_url: '/src/assets/images/avatar_student_two_1794835038041.jpg',
      },
      {
        user_id: 1001005,
        username: 'kabir_inter',
        full_name: 'Kabir Patel',
        role: 'member',
        is_bot: 0,
        msg_count: 7,
        warns: 0,
        avatar_url: null,
      },
    ];

    const insertMember = this.db.prepare(`
      INSERT INTO members (
        chat_id, user_id, username, full_name, role, is_bot,
        is_active, is_muted, muted_until, msg_count, warns, first_seen, last_seen, avatar_url
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 0, NULL, ?, ?, ?, ?, ?)
    `);

    for (const m of seedMembers) {
      insertMember.run(
        DEFAULT_CHAT_ID,
        m.user_id,
        m.username,
        m.full_name,
        m.role,
        m.is_bot,
        m.msg_count,
        m.warns,
        now,
        now,
        m.avatar_url
      );
    }

    const pinResult = this.db
      .prepare(`
        INSERT INTO messages (
          chat_id, sender_id, sender_name, sender_username, sender_role,
          is_bot, text, message_type, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        DEFAULT_CHAT_ID,
        1001001,
        'Meera Nair, FCA',
        'ca_meera',
        'owner',
        0,
        'Group Notice: Direct Tax & Audit RTP revision starts at 8:00 PM IST. Use @CA_Rose_Bot for Section / Ind AS doubts or voice answer evaluations, and /weather <city> for exam-day weather checks.',
        'chat',
        now
      );

    const pinnedId = Number(pinResult.lastInsertRowid);
    this.db
      .prepare('UPDATE group_settings SET pinned_message_id = ? WHERE chat_id = ?')
      .run(pinnedId, DEFAULT_CHAT_ID);

    this.db
      .prepare(`
        INSERT INTO messages (
          chat_id, sender_id, sender_name, sender_username, sender_role,
          is_bot, text, message_type, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        DEFAULT_CHAT_ID,
        1001004,
        'Priya Sharma',
        'priya_articleship',
        'member',
        0,
        '@CA_Rose_Bot Quick check: What is the turnover threshold under Section 44AD for presumptive taxation when cash receipts do not exceed 5%?',
        'chat',
        now
      );

    this.db
      .prepare(`
        INSERT INTO messages (
          chat_id, sender_id, sender_name, sender_username, sender_role,
          is_bot, text, message_type, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        DEFAULT_CHAT_ID,
        BOT_USER_ID,
        'CA Rose Guider',
        BOT_USERNAME_DEFAULT,
        'administrator',
        1,
        'Section 44AD Presumptive Taxation (Income-tax Act, 1961):\n\n• Standard Turnover Limit: Rs. 2 Crore.\n• Enhanced Limit: Rs. 3 Crore, provided aggregate cash receipts during the previous year do not exceed 5% of total turnover/gross receipts.\n• Presumptive Income Rate: 8% of total turnover (6% for turnover received via banking channel / digital modes up to due date of return u/s 139(1)).\n• Exam Tip: Always verify whether the assessee is an eligible resident Individual, HUF, or Partnership Firm (excluding LLP) and check applicability for the relevant Assessment Year.',
        'ca_ai',
        now
      );
  }

  public resetDefaultGroup(): void {
    this.db.prepare('DELETE FROM messages WHERE chat_id = ?').run(DEFAULT_CHAT_ID);
    this.db.prepare('DELETE FROM members WHERE chat_id = ?').run(DEFAULT_CHAT_ID);
    this.db.prepare('DELETE FROM group_settings WHERE chat_id = ?').run(DEFAULT_CHAT_ID);
    this.db.prepare('DELETE FROM ca_notice_log WHERE chat_id = ?').run(DEFAULT_CHAT_ID);
    this.db.prepare('DELETE FROM bot_ca_messages WHERE chat_id = ?').run(DEFAULT_CHAT_ID);
    this.seedIfEmpty();
  }

  public ensureGroup(chatId: number, chatTitle?: string): void {
    const cleanTitle = chatTitle?.trim();
    this.db
      .prepare('INSERT OR IGNORE INTO group_settings (chat_id, chat_title) VALUES (?, ?)')
      .run(chatId, cleanTitle || `Group ${chatId}`);
    if (cleanTitle) {
      this.db
        .prepare('UPDATE group_settings SET chat_title = ? WHERE chat_id = ? AND chat_title != ?')
        .run(cleanTitle, chatId, cleanTitle);
    }
  }

  public getGroupSettings(chatId: number = DEFAULT_CHAT_ID): GroupSettings {
    this.ensureGroup(chatId);
    const row = this.db
      .prepare('SELECT * FROM group_settings WHERE chat_id = ?')
      .get(chatId) as Record<string, unknown>;
    return {
      chat_id: Number(row.chat_id),
      chat_title: String(row.chat_title),
      welcome_enabled: Boolean(row.welcome_enabled),
      welcome_text: String(row.welcome_text),
      rules_text: String(row.rules_text),
      max_warns: Number(row.max_warns),
      pinned_message_id: row.pinned_message_id !== null ? Number(row.pinned_message_id) : null,
    };
  }

  public updateGroupSettings(
    chatId: number,
    patch: Partial<Pick<GroupSettings, 'chat_title' | 'welcome_enabled' | 'welcome_text' | 'rules_text' | 'max_warns' | 'pinned_message_id'>>
  ): GroupSettings {
    this.ensureGroup(chatId);
    const current = this.getGroupSettings(chatId);
    const next = {
      chat_title: patch.chat_title ?? current.chat_title,
      welcome_enabled: patch.welcome_enabled ?? current.welcome_enabled,
      welcome_text: patch.welcome_text ?? current.welcome_text,
      rules_text: patch.rules_text ?? current.rules_text,
      max_warns: patch.max_warns ?? current.max_warns,
      pinned_message_id: patch.pinned_message_id !== undefined ? patch.pinned_message_id : current.pinned_message_id,
    };

    this.db
      .prepare(`
        UPDATE group_settings
        SET chat_title = ?, welcome_enabled = ?, welcome_text = ?, rules_text = ?, max_warns = ?, pinned_message_id = ?
        WHERE chat_id = ?
      `)
      .run(
        next.chat_title,
        next.welcome_enabled ? 1 : 0,
        next.welcome_text,
        next.rules_text,
        next.max_warns,
        next.pinned_message_id,
        chatId
      );

    return this.getGroupSettings(chatId);
  }

  public upsertMember(params: {
    chatId: number;
    userId: number;
    username: string | null;
    fullName: string;
    role?: MemberRole;
    isBot?: boolean;
    isActive?: boolean;
    incrementMsg?: boolean;
    avatarUrl?: string | null;
  }): GroupMember {
    const now = nowUtc();
    const cleanUsername = params.username ? params.username.toLowerCase().replace(/^@/, '') : null;
    const existing = this.getMember(params.chatId, params.userId);

    if (!existing) {
      this.db
        .prepare(`
          INSERT INTO members (
            chat_id, user_id, username, full_name, role, is_bot,
            is_active, is_muted, muted_until, msg_count, warns, first_seen, last_seen, avatar_url
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, 0, ?, ?, ?)
        `)
        .run(
          params.chatId,
          params.userId,
          cleanUsername,
          params.fullName || 'User',
          params.role ?? 'member',
          params.isBot ? 1 : 0,
          params.isActive !== false ? 1 : 0,
          params.incrementMsg ? 1 : 0,
          now,
          now,
          params.avatarUrl ?? null
        );
    } else {
      const nextCount = existing.msg_count + (params.incrementMsg ? 1 : 0);
      this.db
        .prepare(`
          UPDATE members
          SET username = ?, full_name = ?, role = ?, is_bot = ?,
              is_active = ?, msg_count = ?, last_seen = ?, avatar_url = ?
          WHERE chat_id = ? AND user_id = ?
        `)
        .run(
          cleanUsername ?? existing.username,
          params.fullName || existing.full_name,
          params.role ?? existing.role,
          params.isBot !== undefined ? (params.isBot ? 1 : 0) : existing.is_bot ? 1 : 0,
          params.isActive !== undefined ? (params.isActive ? 1 : 0) : existing.is_active ? 1 : 0,
          nextCount,
          now,
          params.avatarUrl !== undefined ? params.avatarUrl : existing.avatar_url,
          params.chatId,
          params.userId
        );
    }

    return this.getMember(params.chatId, params.userId)!;
  }

  private mapMemberRow(row: Record<string, unknown>): GroupMember {
    return {
      chat_id: Number(row.chat_id),
      user_id: Number(row.user_id),
      username: row.username ? String(row.username) : null,
      full_name: String(row.full_name),
      role: (String(row.role) as MemberRole) || 'member',
      is_bot: Boolean(row.is_bot),
      is_active: Boolean(row.is_active),
      is_muted: Boolean(row.is_muted),
      muted_until: row.muted_until ? String(row.muted_until) : null,
      msg_count: Number(row.msg_count),
      warns: Number(row.warns),
      first_seen: String(row.first_seen),
      last_seen: String(row.last_seen),
      avatar_url: row.avatar_url ? String(row.avatar_url) : null,
    };
  }

  public getMember(chatId: number, userId: number): GroupMember | null {
    const row = this.db
      .prepare('SELECT * FROM members WHERE chat_id = ? AND user_id = ?')
      .get(chatId, userId) as Record<string, unknown> | undefined;
    return row ? this.mapMemberRow(row) : null;
  }

  public findMemberByUsernameGlobal(username: string): GroupMember | null {
    const clean = username.trim().replace(/^@/, '').toLowerCase();
    if (!clean) return null;
    const row = this.db
      .prepare('SELECT * FROM members WHERE LOWER(username) = ? ORDER BY last_seen DESC LIMIT 1')
      .get(clean) as Record<string, unknown> | undefined;
    return row ? this.mapMemberRow(row) : null;
  }

  public getMembers(chatId: number = DEFAULT_CHAT_ID): GroupMember[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM members
        WHERE chat_id = ?
        ORDER BY is_bot ASC,
          CASE role WHEN 'owner' THEN 0 WHEN 'administrator' THEN 1 ELSE 2 END,
          last_seen DESC
      `)
      .all(chatId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapMemberRow(r));
  }

  public setMemberActive(chatId: number, userId: number, isActive: boolean): void {
    this.db
      .prepare('UPDATE members SET is_active = ?, last_seen = ? WHERE chat_id = ? AND user_id = ?')
      .run(isActive ? 1 : 0, nowUtc(), chatId, userId);
  }

  public setMemberMuted(chatId: number, userId: number, isMuted: boolean, mutedUntil: string | null): void {
    this.db
      .prepare('UPDATE members SET is_muted = ?, muted_until = ?, last_seen = ? WHERE chat_id = ? AND user_id = ?')
      .run(isMuted ? 1 : 0, mutedUntil, nowUtc(), chatId, userId);
  }

  public setMemberRole(chatId: number, userId: number, role: MemberRole): void {
    this.db
      .prepare('UPDATE members SET role = ?, last_seen = ? WHERE chat_id = ? AND user_id = ?')
      .run(role, nowUtc(), chatId, userId);
  }

  public addWarn(chatId: number, userId: number): number {
    this.db
      .prepare('UPDATE members SET warns = warns + 1, last_seen = ? WHERE chat_id = ? AND user_id = ?')
      .run(nowUtc(), chatId, userId);
    const updated = this.getMember(chatId, userId);
    return updated ? updated.warns : 1;
  }

  public resetWarns(chatId: number, userId: number): void {
    this.db
      .prepare('UPDATE members SET warns = 0, last_seen = ? WHERE chat_id = ? AND user_id = ?')
      .run(nowUtc(), chatId, userId);
  }

  public addMessage(params: {
    chatId: number;
    senderId: number;
    senderName: string;
    senderUsername: string | null;
    senderRole: MemberRole;
    isBot: boolean;
    text: string;
    replyToId?: number | null;
    replyToSnippet?: string | null;
    audioName?: string | null;
    audioMime?: string | null;
    messageType?: ChatMessage['message_type'];
  }): ChatMessage {
    const now = nowUtc();
    const res = this.db
      .prepare(`
        INSERT INTO messages (
          chat_id, sender_id, sender_name, sender_username, sender_role,
          is_bot, text, reply_to_id, reply_to_snippet, audio_name, audio_mime, message_type, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        params.chatId,
        params.senderId,
        params.senderName,
        params.senderUsername,
        params.senderRole,
        params.isBot ? 1 : 0,
        params.text,
        params.replyToId ?? null,
        params.replyToSnippet ?? null,
        params.audioName ?? null,
        params.audioMime ?? null,
        params.messageType ?? 'chat',
        now
      );

    return this.getMessageById(Number(res.lastInsertRowid))!;
  }

  private mapMessageRow(row: Record<string, unknown>): ChatMessage {
    return {
      id: Number(row.id),
      chat_id: Number(row.chat_id),
      sender_id: Number(row.sender_id),
      sender_name: String(row.sender_name),
      sender_username: row.sender_username ? String(row.sender_username) : null,
      sender_role: (String(row.sender_role) as MemberRole) || 'member',
      is_bot: Boolean(row.is_bot),
      text: String(row.text),
      reply_to_id: row.reply_to_id !== null ? Number(row.reply_to_id) : null,
      reply_to_snippet: row.reply_to_snippet ? String(row.reply_to_snippet) : null,
      audio_name: row.audio_name ? String(row.audio_name) : null,
      audio_mime: row.audio_mime ? String(row.audio_mime) : null,
      message_type: (String(row.message_type) as ChatMessage['message_type']) || 'chat',
      created_at: String(row.created_at),
    };
  }

  public getMessageById(id: number): ChatMessage | null {
    const row = this.db
      .prepare('SELECT * FROM messages WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapMessageRow(row) : null;
  }

  public getMessages(chatId: number = DEFAULT_CHAT_ID, limit: number = 80): ChatMessage[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM (
          SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?
        ) ORDER BY id ASC
      `)
      .all(chatId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapMessageRow(r));
  }

  public hasCaNoticeSent(chatId: number, userId: number): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM ca_notice_log WHERE chat_id = ? AND user_id = ?')
      .get(chatId, userId);
    return Boolean(row);
  }

  public markCaNoticeSent(chatId: number, userId: number): void {
    this.db
      .prepare('INSERT OR REPLACE INTO ca_notice_log (chat_id, user_id, last_notified_at) VALUES (?, ?, ?)')
      .run(chatId, userId, nowUtc());
  }

  public markBotCaMessage(chatId: number, messageId: number): void {
    this.db
      .prepare('INSERT OR REPLACE INTO bot_ca_messages (chat_id, message_id, created_at) VALUES (?, ?, ?)')
      .run(chatId, messageId, nowUtc());
  }

  public isBotCaMessage(chatId: number, messageId: number): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM bot_ca_messages WHERE chat_id = ? AND message_id = ?')
      .get(chatId, messageId);
    return Boolean(row);
  }

  public getConfig(key: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM bot_config WHERE key = ?')
      .get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  }

  public setConfig(key: string, value: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO bot_config (key, value, updated_at) VALUES (?, ?, ?)')
      .run(key, value, nowUtc());
  }

  public deleteConfig(key: string): void {
    this.db.prepare('DELETE FROM bot_config WHERE key = ?').run(key);
  }
}

export const botDb = new BotDatabase();

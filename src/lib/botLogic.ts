import type { GroupMember } from '../types';

export const MAX_TELEGRAM_MESSAGE_LEN = 4096;
export const BOT_USERNAME_DEFAULT = 'CA_Rose_Bot';
export const BOT_USER_ID = 9000001;

export const WMO_CODES: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  71: 'Slight snowfall',
  73: 'Moderate snowfall',
  75: 'Heavy snowfall',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with slight hail',
  99: 'Thunderstorm with heavy hail',
};

export function formatWmoWeather(code: number): string {
  return WMO_CODES[code] ?? 'Weather update';
}

export function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export interface ParsedCommand {
  command: string;
  args: string[];
  rawArgs: string;
}

export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }
  const spaceIdx = trimmed.search(/\s/);
  const head = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const rawArgs = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx).trim();
  const cmdName = head.slice(1).split('@')[0].toLowerCase();
  if (!cmdName) {
    return null;
  }
  const args = rawArgs ? rawArgs.split(/\s+/) : [];
  return { command: cmdName, args, rawArgs };
}

export function isBotMentionedOrReplied(
  text: string,
  botUsername: string,
  isReplyToBot: boolean,
  isPrivate: boolean
): boolean {
  if (isPrivate) {
    return true;
  }
  if (isReplyToBot) {
    return true;
  }
  if (!botUsername) {
    return false;
  }
  const escaped = botUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`@${escaped}\\b`, 'i');
  return pattern.test(text);
}

export function stripBotMention(text: string, botUsername: string): string {
  if (!botUsername) {
    return text.trim();
  }
  const escaped = botUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`@${escaped}\\b`, 'gi');
  return text.replace(pattern, '').replace(/\s{2,}/g, ' ').trim();
}

export const DEFAULT_WELCOME_TEXT =
  'Hello {name}! How are you doing? Welcome to {chat_title}!';

export function formatBotGroupAddedGreeting(chatTitle?: string | null): string {
  const cleanTitle = (chatTitle || '').trim();
  if (cleanTitle) {
    return `Hello everyone! How are you all doing? Happy to join ${cleanTitle}!`;
  }
  return 'Hello everyone! How are you all doing? Happy to be here!';
}

export const BOT_GROUP_ADDED_GREETING = formatBotGroupAddedGreeting();

export function renderWelcomeMessage(
  template: string,
  member: Pick<GroupMember, 'user_id' | 'full_name' | 'username'>,
  chatTitle: string,
  mode: 'plain' | 'html' = 'plain'
): string {
  const mention =
    mode === 'html'
      ? `<a href="tg://user?id=${member.user_id}">${escapeHtml(member.full_name || 'User')}</a>`
      : member.username
        ? `@${member.username}`
        : member.full_name;

  const base = mode === 'html' ? escapeHtml(template) : template;
  const safeName = mode === 'html' ? escapeHtml(member.full_name) : member.full_name;
  const safeTitle = mode === 'html' ? escapeHtml(chatTitle) : chatTitle;

  return base
    .replaceAll('{mention}', mention)
    .replaceAll('{name}', safeName)
    .replaceAll('{chat_title}', safeTitle);
}

export const SYSTEM_TG_ACCOUNT_IDS = new Set([1087968824, 777000, 136817688]);

export interface TargetResolutionResult {
  member: GroupMember | null;
  numericUserId: number | null;
  mentionUsername: string | null;
  matchedArgIndex: number | null;
  remainingArgs: string[];
  resolvedFromReply: boolean;
}

function cleanMentionToken(token: string): string | null {
  const trimmed = token.trim().replace(/[.,:;!?]+$/, '');
  if (!trimmed.startsWith('@') || trimmed.length <= 1) return null;
  const clean = trimmed.slice(1).toLowerCase();
  return clean || null;
}

export function resolveTargetWithArgs(
  args: string[],
  replySenderId: number | null,
  members: GroupMember[],
  options?: { botUsername?: string }
): TargetResolutionResult {
  if (replySenderId !== null) {
    const found = members.find((m) => m.user_id === replySenderId) ?? null;
    return {
      member: found,
      numericUserId: replySenderId,
      mentionUsername: null,
      matchedArgIndex: null,
      remainingArgs: [...args],
      resolvedFromReply: true,
    };
  }

  const botClean = options?.botUsername?.replace(/^@/, '').toLowerCase() || '';
  const hasOtherTarget = args.some((a, i) => {
    const m = cleanMentionToken(a);
    if (m && m !== botClean) return true;
    const t = a.trim().replace(/[.,:;!?]+$/, '');
    return /^\d{5,}$/.test(t) && i >= 0;
  });

  for (let idx = 0; idx < args.length; idx++) {
    const token = args[idx].trim().replace(/[.,:;!?]+$/, '');
    if (/^\d+$/.test(token)) {
      const uid = Number(token);
      const found = members.find((m) => m.user_id === uid) ?? null;
      if (found || token.length >= 5) {
        return {
          member: found,
          numericUserId: uid,
          mentionUsername: null,
          matchedArgIndex: idx,
          remainingArgs: args.filter((_, i) => i !== idx),
          resolvedFromReply: false,
        };
      }
    }
    const clean = cleanMentionToken(token);
    if (clean) {
      if (botClean && clean === botClean && hasOtherTarget) {
        continue;
      }
      const found = members.find((m) => (m.username ?? '').toLowerCase() === clean) ?? null;
      return {
        member: found,
        numericUserId: found?.user_id ?? null,
        mentionUsername: clean,
        matchedArgIndex: idx,
        remainingArgs: args.filter((_, i) => i !== idx),
        resolvedFromReply: false,
      };
    }
  }

  return {
    member: null,
    numericUserId: null,
    mentionUsername: null,
    matchedArgIndex: null,
    remainingArgs: [...args],
    resolvedFromReply: false,
  };
}

export function resolveTargetMember(
  args: string[],
  replySenderId: number | null,
  members: GroupMember[]
): GroupMember | null {
  return resolveTargetWithArgs(args, replySenderId, members).member;
}

export interface TagAllChunk {
  text: string;
  htmlText: string;
  count: number;
  chunkIndex: number;
  totalChunks: number;
}

export interface TagAllChunksResult {
  chunks: TagAllChunk[];
  totalCount: number;
  chunkCount: number;
  maxMentionsPerChunk: number;
}

export const TAGALL_DEFAULT_CHUNK_SIZE = 100;
export const TAGALL_SAFE_MAX_CHARS = 3800;
export const TAGALL_SAFE_MAX_RAW_HTML = 12000;

function formatCompactTagLabel(fullName: string, compact: boolean): string {
  const clean = (fullName || 'Member').trim().replace(/\s+/g, ' ');
  if (!compact) {
    return clean.length > 24 ? clean.slice(0, 23).trimEnd() + '…' : clean;
  }
  const first = clean.split(' ')[0] || 'Member';
  return first.length > 14 ? first.slice(0, 13).trimEnd() + '…' : first;
}

export function buildTagAllChunks(
  members: Array<Pick<GroupMember, 'user_id' | 'username' | 'full_name' | 'is_active' | 'is_bot'>>,
  note: string,
  maxChars: number = TAGALL_SAFE_MAX_CHARS,
  maxMentionsPerChunk: number = TAGALL_DEFAULT_CHUNK_SIZE
): TagAllChunksResult {
  const activeHumans = members.filter((m) => m.is_active && !m.is_bot);
  const cleanNote = note.trim() || 'Attention everyone!';

  if (activeHumans.length === 0) {
    const emptyMsg = 'No active group members tracked yet.';
    return {
      chunks: [
        {
          text: emptyMsg,
          htmlText: escapeHtml(emptyMsg),
          count: 0,
          chunkIndex: 1,
          totalChunks: 1,
        },
      ],
      totalCount: 0,
      chunkCount: 1,
      maxMentionsPerChunk,
    };
  }

  const useCompactNames = activeHumans.length > 25;
  const rawChunks: Array<{ htmlTags: string[]; plainTags: string[]; count: number }> = [];
  let curHtmlTags: string[] = [];
  let curPlainTags: string[] = [];
  let curHtmlLen = 0;
  let curVisibleLen = 0;

  // Reserve room for header like "<b>note (99/99)</b>\n\n"
  const headerReserve = Math.max(cleanNote.length + 32, 64);
  const effectiveVisibleMax = Math.max(400, maxChars - headerReserve);
  const effectiveRawHtmlMax = Math.max(effectiveVisibleMax, TAGALL_SAFE_MAX_RAW_HTML - headerReserve * 2);

  for (const member of activeHumans) {
    const label = formatCompactTagLabel(member.full_name, useCompactNames);
    const htmlTag = member.username
      ? `@${escapeHtml(member.username.replace(/^@/, ''))}`
      : `<a href="tg://user?id=${member.user_id}">${escapeHtml(label)}</a>`;
    const plainTag = member.username
      ? `@${member.username.replace(/^@/, '')}`
      : label;

    const visibleTokenLen = member.username ? plainTag.length : label.length;
    const wouldExceedCount = curHtmlTags.length >= maxMentionsPerChunk;
    const wouldExceedVisibleLen =
      curHtmlTags.length > 0 && curVisibleLen + visibleTokenLen + 1 > effectiveVisibleMax;
    const wouldExceedRawHtml =
      curHtmlTags.length > 0 && curHtmlLen + htmlTag.length + 1 > effectiveRawHtmlMax;

    if (wouldExceedCount || wouldExceedVisibleLen || wouldExceedRawHtml) {
      rawChunks.push({
        htmlTags: curHtmlTags,
        plainTags: curPlainTags,
        count: curHtmlTags.length,
      });
      curHtmlTags = [];
      curPlainTags = [];
      curHtmlLen = 0;
      curVisibleLen = 0;
    }

    curHtmlTags.push(htmlTag);
    curPlainTags.push(plainTag);
    curHtmlLen += htmlTag.length + 1;
    curVisibleLen += visibleTokenLen + 1;
  }

  if (curHtmlTags.length > 0) {
    rawChunks.push({
      htmlTags: curHtmlTags,
      plainTags: curPlainTags,
      count: curHtmlTags.length,
    });
  }

  const totalChunks = rawChunks.length;
  const chunks: TagAllChunk[] = rawChunks.map((rc, idx) => {
    const partSuffix = totalChunks > 1 ? ` (${idx + 1}/${totalChunks})` : '';
    const htmlHeader = `<b>${escapeHtml(cleanNote)}${partSuffix}</b>\n\n`;
    const plainHeader = `${cleanNote}${partSuffix}\n\n`;
    return {
      text: plainHeader + rc.plainTags.join(' · '),
      htmlText: htmlHeader + rc.htmlTags.join(' '),
      count: rc.count,
      chunkIndex: idx + 1,
      totalChunks,
    };
  });

  return {
    chunks,
    totalCount: activeHumans.length,
    chunkCount: totalChunks,
    maxMentionsPerChunk,
  };
}

export interface TagAllBuildResult {
  text: string;
  htmlText: string;
  mode: 'full' | 'chunked';
  taggedCount: number;
  totalCount: number;
  chunkCount: number;
  charLength: number;
}

export function buildTagAllMessage(
  members: Array<Pick<GroupMember, 'user_id' | 'username' | 'full_name' | 'is_active' | 'is_bot'>>,
  note: string,
  maxLen: number = MAX_TELEGRAM_MESSAGE_LEN
): TagAllBuildResult {
  const res = buildTagAllChunks(members, note, Math.min(maxLen, TAGALL_SAFE_MAX_CHARS), TAGALL_DEFAULT_CHUNK_SIZE);
  const combinedPlain = res.chunks.map((c) => c.text).join('\n\n');
  const firstHtml = res.chunks[0]?.htmlText ?? '';
  return {
    text: combinedPlain,
    htmlText: firstHtml,
    mode: res.chunkCount > 1 ? 'chunked' : 'full',
    taggedCount: res.totalCount,
    totalCount: res.totalCount,
    chunkCount: res.chunkCount,
    charLength: firstHtml.length,
  };
}

export type BotPermissionKey =
  | 'can_delete_messages'
  | 'can_restrict_members'
  | 'can_pin_messages'
  | 'can_promote_members';

export interface BotAdminRightsInput {
  status: string;
  can_delete_messages?: boolean;
  can_restrict_members?: boolean;
  can_pin_messages?: boolean;
  can_promote_members?: boolean;
  can_manage_chat?: boolean;
  can_invite_users?: boolean;
  can_manage_video_chats?: boolean;
}

export interface BotPermissionCheckResult {
  ok: boolean;
  isAdmin: boolean;
  missingLabels: string[];
  debugHtml: string;
  debugPlain: string;
}

const PERMISSION_LABELS: Record<BotPermissionKey, string> = {
  can_delete_messages: 'Delete Messages',
  can_restrict_members: 'Ban Users (Restrict Members)',
  can_pin_messages: 'Pin Messages',
  can_promote_members: 'Add New Admins (Promote/Demote)',
};

export function evaluateBotAdminPermissions(
  botMember: BotAdminRightsInput | null,
  requiredKeys: BotPermissionKey[],
  commandName: string
): BotPermissionCheckResult {
  const status = botMember?.status ?? 'left';
  const isCreator = status === 'creator' || status === 'owner';
  const isAdmin = isCreator || status === 'administrator';

  const missingKeys: BotPermissionKey[] = [];
  for (const key of requiredKeys) {
    if (isCreator) continue;
    if (!isAdmin || !botMember?.[key]) {
      missingKeys.push(key);
    }
  }

  const ok = isAdmin && missingKeys.length === 0;
  const missingLabels = [
    ...(!isAdmin ? ['Administrator Role'] : []),
    ...missingKeys.map((k) => PERMISSION_LABELS[k]),
  ];

  const linesPlain: string[] = [
    `Permission Debug for /${commandName}:`,
    `• Bot Group Status: ${isAdmin ? status.toUpperCase() : `${status.toUpperCase()} (Not Admin)`}`,
    `• Required Permissions:`,
    ...requiredKeys.map((k) => {
      const granted = isCreator || (isAdmin && Boolean(botMember?.[k]));
      return `  ${granted ? '✅' : '❌'} ${PERMISSION_LABELS[k]}`;
    }),
  ];
  if (!ok) {
    linesPlain.push(
      `Fix: Open Group Settings → Administrators → select this bot and enable: ${missingLabels.join(', ')}.`
    );
  }

  const linesHtml: string[] = [
    `<b>Permission Debug for /${escapeHtml(commandName)}</b>`,
    `• <b>Bot Group Status:</b> ${isAdmin ? escapeHtml(status.toUpperCase()) : `${escapeHtml(status.toUpperCase())} (Not Admin)`}`,
    `• <b>Required Permissions:</b>`,
    ...requiredKeys.map((k) => {
      const granted = isCreator || (isAdmin && Boolean(botMember?.[k]));
      return `  ${granted ? '✅' : '❌'} ${escapeHtml(PERMISSION_LABELS[k])}`;
    }),
  ];
  if (!ok) {
    linesHtml.push(
      `\n<i>Fix: Group Settings → Administrators → select this bot and enable: <b>${escapeHtml(missingLabels.join(', '))}</b>.</i>`
    );
  }

  return {
    ok,
    isAdmin,
    missingLabels,
    debugHtml: linesHtml.join('\n'),
    debugPlain: linesPlain.join('\n'),
  };
}

export interface PromoteRightsEvaluation {
  ok: boolean;
  rights: {
    can_manage_chat: boolean;
    can_delete_messages: boolean;
    can_manage_video_chats: boolean;
    can_restrict_members: boolean;
    can_invite_users: boolean;
    can_pin_messages: boolean;
  };
  reason?: string;
}

export function evaluatePromoteBotRights(botMember: BotAdminRightsInput | null): PromoteRightsEvaluation {
  const status = botMember?.status ?? 'left';
  const isCreator = status === 'creator' || status === 'owner';
  const rights = {
    can_manage_chat: isCreator || Boolean(botMember?.can_manage_chat),
    can_delete_messages: isCreator || Boolean(botMember?.can_delete_messages),
    can_manage_video_chats: isCreator || Boolean(botMember?.can_manage_video_chats),
    can_restrict_members: isCreator || Boolean(botMember?.can_restrict_members),
    can_invite_users: isCreator || Boolean(botMember?.can_invite_users),
    can_pin_messages: isCreator || Boolean(botMember?.can_pin_messages),
  };

  const hasAnyRight = Object.values(rights).some(Boolean);
  if (!hasAnyRight) {
    return {
      ok: false,
      rights,
      reason:
        'I only have "Add New Admins" enabled with zero other admin permissions to grant. Telegram treats promoting with all permissions disabled as a demotion/no-op. Enable at least one permission (e.g., Delete Messages, Ban Users, or Pin Messages) for me first.',
    };
  }
  return { ok: true, rights };
}

export type ModerationAction =
  | 'ban'
  | 'unban'
  | 'kick'
  | 'mute'
  | 'unmute'
  | 'promote'
  | 'demote'
  | 'warn';

export interface TargetValidationInput {
  action: ModerationAction;
  actorId: number | null;
  botId: number;
  targetId: number;
  targetName: string;
  targetStatus?: string | null;
  targetIsBot?: boolean;
  targetCanBeEdited?: boolean | null;
}

export interface TargetValidationResult {
  allowed: boolean;
  reason?: string;
  ownerLocked?: boolean;
}

export function validateModerationTarget(input: TargetValidationInput): TargetValidationResult {
  const { action, actorId, botId, targetId, targetName, targetStatus, targetIsBot, targetCanBeEdited } = input;
  const status = (targetStatus ?? '').toLowerCase();

  if (targetId === botId) {
    return { allowed: false, reason: `I cannot /${action} myself.` };
  }
  if (SYSTEM_TG_ACCOUNT_IDS.has(targetId)) {
    return { allowed: false, reason: 'Cannot moderate anonymous admin or linked Telegram channel posts.' };
  }
  if (actorId !== null && targetId === actorId && action !== 'unban' && action !== 'unmute') {
    return { allowed: false, reason: `You cannot /${action} yourself.` };
  }

  const isTargetCreator = status === 'creator' || status === 'owner';
  const isTargetAdmin = isTargetCreator || status === 'administrator';

  if (action === 'ban' || action === 'kick' || action === 'mute' || action === 'warn') {
    if (isTargetAdmin) {
      return { allowed: false, reason: `Cannot ${action} a group ${isTargetCreator ? 'creator' : 'administrator'}.` };
    }
    if ((action === 'kick' || action === 'mute') && (status === 'left' || status === 'kicked')) {
      return { allowed: false, reason: `Cannot ${action} ${targetName}: user is not currently in the group.` };
    }
    return { allowed: true };
  }

  if (action === 'unban') {
    if (status && status !== 'kicked' && status !== 'left') {
      return { allowed: false, reason: `${targetName} is not banned in this group.` };
    }
    return { allowed: true };
  }

  if (action === 'unmute') {
    if (isTargetAdmin) {
      return { allowed: false, reason: `${targetName} is an admin and cannot be muted/unmuted.` };
    }
    return { allowed: true };
  }

  if (action === 'promote') {
    if (isTargetCreator) {
      return { allowed: false, reason: 'Cannot modify the group creator.' };
    }
    if (targetIsBot) {
      return { allowed: false, reason: 'Cannot promote another bot via /promote; manage bot admins in Telegram Group Settings.' };
    }
    if (status === 'left' || status === 'kicked') {
      return { allowed: false, reason: `Cannot promote ${targetName}: user is not currently in the group.` };
    }
    if (status === 'administrator' && targetCanBeEdited === false) {
      return { allowed: false, ownerLocked: true };
    }
    return { allowed: true };
  }

  if (action === 'demote') {
    if (isTargetCreator) {
      return { allowed: false, reason: 'Cannot demote the group creator.' };
    }
    if (status && status !== 'administrator') {
      return { allowed: false, reason: `${targetName} is not an administrator.` };
    }
    if (status === 'administrator' && targetCanBeEdited === false) {
      return { allowed: false, ownerLocked: true };
    }
    return { allowed: true };
  }

  return { allowed: true };
}

export function parseDurationMinutes(token: string): number | null {
  const clean = token.trim().toLowerCase().replace(/[.,:;!?]+$/, '');
  const match = clean.match(/^(\d+)(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks)?$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unitRaw = match[2] ?? 'm';
  const unit = unitRaw.startsWith('h')
    ? 'h'
    : unitRaw.startsWith('d')
      ? 'd'
      : unitRaw.startsWith('w')
        ? 'w'
        : 'm';
  const multiplier =
    unit === 'm' ? 1 : unit === 'h' ? 60 : unit === 'd' ? 1440 : unit === 'w' ? 10080 : 1;
  const total = amount * multiplier;
  if (total <= 0 || total > 525600) return null; // cap at 1 year (Telegram max ~366d)
  return total;
}

export function extractMuteMinutes(args: string[], targetResolvedFromReply: boolean, targetUserId: number): number | null {
  for (const arg of args) {
    const trimmed = arg.trim();
    if (!targetResolvedFromReply && /^\d+$/.test(trimmed) && Number(trimmed) === targetUserId) {
      continue;
    }
    const parsed = parseDurationMinutes(trimmed);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

export function chunkTelegramText(text: string, maxLen: number = MAX_TELEGRAM_MESSAGE_LEN): string[] {
  const clean = text.trim() || 'I could not generate a response. Please try again.';
  const chunks: string[] = [];
  for (let i = 0; i < clean.length; i += maxLen) {
    chunks.push(clean.slice(i, i + maxLen));
  }
  return chunks;
}

export const NON_CA_SENTINEL = '[NON_CA_QUERY]';

export const CA_ONE_TIME_NOTICE =
  'I specialize strictly in Chartered Accountancy (CA / ICAI) studies & exams. Tag me whenever you have a CA doubt or voice/audio answer to evaluate!';

const CASUAL_ACK_PATTERN =
  /^(ok+|okay|kk?|thanks?|thank\s*you|thx|tq|ty|hm+|hmm+|yes|no|yeah|yep|nope|yup|haha+|lol|lmao|nice|great|cool|good|gm|gn|good\s*(morning|night|evening)|hi+|hello+|hey+|bye+|done|got\s*it|noted|sure|alright|haan|ji|accha|achha|theek|thik|dhanyawad|shukriya|bhai|bro|sir|maam|mam)[!.,?\s]*$/i;

export function isCasualAckOrGreeting(text: string): boolean {
  const clean = text.trim();
  if (!clean) return false;
  if (CASUAL_ACK_PATTERN.test(clean)) return true;
  // Emoji/punctuation-only strings with no letters or digits
  const strippedAlphaNum = clean.replace(/[\p{L}\p{N}]/gu, '');
  return strippedAlphaNum.length === clean.length;
}

export function isNonCaSentinelOrRefusal(answer: string): boolean {
  const clean = answer.trim();
  if (!clean) return false;
  if (clean.toUpperCase().startsWith(NON_CA_SENTINEL)) return true;
  const lower = clean.toLowerCase();
  return (
    (lower.includes('strictly specialized in ca') ||
      lower.includes('only answer questions related to chartered accountancy') ||
      lower.includes('only help with chartered accountancy') ||
      lower.includes('only assist with ca')) &&
    clean.length < 320
  );
}

export function isTelegramAdminLockError(errMessage: string): boolean {
  const upper = errMessage.toUpperCase();
  return (
    upper.includes('CHAT_ADMIN_REQUIRED') ||
    upper.includes('RIGHT_FORBIDDEN') ||
    upper.includes('NOT ENOUGH RIGHTS') ||
    upper.includes('ADMIN_RANK_EMOJI_NOT_ALLOWED') ||
    upper.includes("CAN'T EDIT ADMIN")
  );
}

export function isFreshSessionAdminError(errMessage: string): boolean {
  return errMessage.toUpperCase().includes('FRESH_CHANGE_ADMINS_FORBIDDEN');
}

export function isTransientTimeoutOrNetworkError(err: unknown): boolean {
  if (!err) return false;
  const name = typeof err === 'object' && 'name' in err ? String((err as { name?: unknown }).name || '') : '';
  const msg = err instanceof Error ? err.message : String(err);
  const combined = `${name} ${msg}`.toLowerCase();
  return (
    combined.includes('timeout') ||
    combined.includes('timed out') ||
    combined.includes('aborterror') ||
    combined.includes('timeouterror') ||
    combined.includes('aborted') ||
    combined.includes('etimedout') ||
    combined.includes('econnreset') ||
    combined.includes('econnrefused') ||
    combined.includes('eai_again') ||
    combined.includes('enotfound') ||
    combined.includes('fetch failed') ||
    combined.includes('und_err_socket') ||
    combined.includes('und_err_connect_timeout') ||
    combined.includes('socket hang up')
  );
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label = 'Operation'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export function computeSessionCooldownRemaining(
  connectedAtIso: string | null,
  nowMs: number = Date.now()
): { inCooldown: boolean; remainingMinutes: number; label: string | null } {
  if (!connectedAtIso) {
    return { inCooldown: false, remainingMinutes: 0, label: null };
  }
  const connectedMs = Date.parse(connectedAtIso);
  if (!Number.isFinite(connectedMs)) {
    return { inCooldown: false, remainingMinutes: 0, label: null };
  }
  const cooldownMs = 24 * 60 * 60 * 1000;
  const remainingMs = connectedMs + cooldownMs - nowMs;
  if (remainingMs <= 0) {
    return { inCooldown: false, remainingMinutes: 0, label: null };
  }
  const remainingMinutes = Math.ceil(remainingMs / 60000);
  const hours = Math.floor(remainingMinutes / 60);
  const mins = remainingMinutes % 60;
  const label = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
  return { inCooldown: true, remainingMinutes, label };
}

export interface MtprotoAdminRightsFlags {
  changeInfo: boolean;
  postMessages: boolean;
  editMessages: boolean;
  deleteMessages: boolean;
  banUsers: boolean;
  inviteUsers: boolean;
  pinMessages: boolean;
  addAdmins: boolean;
  anonymous: boolean;
  manageCall: boolean;
  other: boolean;
  manageTopics: boolean;
}

export function buildMtprotoAdminRights(
  promote: boolean,
  botRights?: PromoteRightsEvaluation['rights']
): MtprotoAdminRightsFlags {
  if (!promote) {
    return {
      changeInfo: false,
      postMessages: false,
      editMessages: false,
      deleteMessages: false,
      banUsers: false,
      inviteUsers: false,
      pinMessages: false,
      addAdmins: false,
      anonymous: false,
      manageCall: false,
      other: false,
      manageTopics: false,
    };
  }
  return {
    changeInfo: false,
    postMessages: false,
    editMessages: false,
    deleteMessages: botRights?.can_delete_messages ?? true,
    banUsers: botRights?.can_restrict_members ?? true,
    inviteUsers: botRights?.can_invite_users ?? true,
    pinMessages: botRights?.can_pin_messages ?? true,
    addAdmins: false,
    anonymous: false,
    manageCall: botRights?.can_manage_video_chats ?? true,
    other: botRights?.can_manage_chat ?? true,
    manageTopics: false,
  };
}

export interface GeminiErrorDetails {
  code?: number;
  status?: string;
  message: string;
  retryable: boolean;
  shouldFallbackModel: boolean;
  friendlyMessage: string;
}

export function parseGeminiErrorDetails(err: unknown): GeminiErrorDetails {
  const rawMsg = err instanceof Error ? err.message : String(err || 'Unknown Gemini error');
  let code: number | undefined;
  let status: string | undefined;
  let innerMsg = rawMsg;

  const trimmed = rawMsg.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as {
        error?: { code?: number; status?: string; message?: string };
        code?: number;
        status?: string;
        message?: string;
      };
      const payload = parsed.error ?? parsed;
      if (typeof payload.code === 'number') code = payload.code;
      if (typeof payload.status === 'string') status = payload.status;
      if (typeof payload.message === 'string' && payload.message.trim()) {
        innerMsg = payload.message.trim();
      }
    } catch {
      // keep raw message
    }
  }

  const upper = `${status || ''} ${innerMsg}`.toUpperCase();
  const transient = isTransientTimeoutOrNetworkError(err) || isTransientTimeoutOrNetworkError(innerMsg);

  if (code === undefined) {
    if (upper.includes('503') || upper.includes('UNAVAILABLE')) code = 503;
    else if (upper.includes('429') || upper.includes('RESOURCE_EXHAUSTED')) code = 429;
    else if (upper.includes('403') || upper.includes('PERMISSION_DENIED')) code = 403;
    else if (upper.includes('404') || upper.includes('NOT_FOUND')) code = 404;
    else if (upper.includes('400') || upper.includes('API_KEY_INVALID') || upper.includes('INVALID_ARGUMENT')) code = 400;
    else if (upper.includes('500') || upper.includes('INTERNAL')) code = 500;
  }

  const retryable =
    transient ||
    code === 429 ||
    code === 500 ||
    code === 502 ||
    code === 503 ||
    code === 504 ||
    upper.includes('UNAVAILABLE') ||
    upper.includes('HIGH DEMAND') ||
    upper.includes('RESOURCE_EXHAUSTED') ||
    upper.includes('DEADLINE_EXCEEDED');

  const shouldFallbackModel =
    retryable ||
    code === 404 ||
    upper.includes('NOT_FOUND') ||
    upper.includes('NOT SUPPORTED');

  let friendlyMessage = innerMsg;
  if (code === 403 || upper.includes('API_KEY_INVALID') || upper.includes('GEMINI_API_KEY')) {
    friendlyMessage =
      'Gemini API key is missing, invalid, or lacks permissions. Check GEMINI_API_KEY in Settings → Secrets.';
  } else if (code === 429 || upper.includes('RESOURCE_EXHAUSTED')) {
    friendlyMessage = 'Gemini API rate limit reached temporarily. Please wait a moment and try again.';
  } else if (transient || code === 503 || upper.includes('UNAVAILABLE') || upper.includes('HIGH DEMAND')) {
    friendlyMessage = 'Gemini AI is experiencing temporary high demand right now. Please try again in a few seconds.';
  } else if (code === 404 || upper.includes('NOT_FOUND')) {
    friendlyMessage = 'Configured Gemini model is currently unavailable.';
  }

  return {
    code,
    status,
    message: innerMsg,
    retryable,
    shouldFallbackModel,
    friendlyMessage,
  };
}

export function formatTelegramModErrorHtml(
  actionVerb: string,
  targetLabelHtml: string | null,
  rawError: unknown,
  commandName?: string
): string {
  const errMsg = rawError instanceof Error ? rawError.message : String(rawError || `${actionVerb} failed`);
  const upper = errMsg.toUpperCase();
  const cmdLabel = commandName || actionVerb;
  const targetPrefix = targetLabelHtml ? ` ${targetLabelHtml}` : '';

  if (upper.includes('USER_ADMIN_INVALID') || upper.includes('OWNER')) {
    return `Cannot ${escapeHtml(actionVerb)}${targetPrefix}: Telegram does not allow restricting or banning group admins/owner. Demote them first with /demote.`;
  }
  if (upper.includes('NOT ENOUGH RIGHTS') || upper.includes('CHAT_ADMIN_REQUIRED') || upper.includes('RIGHT_FORBIDDEN')) {
    if (actionVerb === 'delete' || cmdLabel === 'del') {
      return `Bot lacks <b>Delete Messages</b> permission in Group Settings → Administrators.`;
    }
    if (actionVerb === 'pin' || actionVerb === 'unpin') {
      return `Bot lacks <b>Pin Messages</b> permission in Group Settings → Administrators.`;
    }
    return `Bot lacks required admin permissions in Group Settings → Administrators for <code>/${escapeHtml(cmdLabel)}</code>.`;
  }
  if (upper.includes('SUPERGROUP')) {
    return `<code>/${escapeHtml(cmdLabel)}</code> requires the group to be upgraded to a Telegram Supergroup.`;
  }
  if (upper.includes('USER_NOT_PARTICIPANT')) {
    return `Cannot ${escapeHtml(actionVerb)}${targetPrefix}: user is not currently in this group.`;
  }
  if (upper.includes("MESSAGE CAN'T BE DELETED") || upper.includes('MESSAGE TO DELETE NOT FOUND')) {
    return `Could not delete message: Telegram only allows deleting messages less than 48 hours old (or it was already deleted).`;
  }
  if (upper.includes('MESSAGE TO PIN NOT FOUND') || upper.includes('MESSAGE_ID_INVALID')) {
    return `Target message could not be found in this chat.`;
  }
  if (upper.includes('CHAT_NOT_MODIFIED')) {
    return targetLabelHtml
      ? `${targetLabelHtml} is already in that state.`
      : `No changes needed — chat state is already updated.`;
  }
  return `Failed to ${escapeHtml(actionVerb)}${targetPrefix}: <code>${escapeHtml(errMsg)}</code>`;
}

export interface WebhookUrlValidation {
  ok: boolean;
  baseUrl?: string;
  webhookEndpoint?: string;
  error?: string;
}

export function normalizeWebhookBaseUrl(rawInput: string): WebhookUrlValidation {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: 'Enter your public deployed HTTPS app URL (e.g. https://your-bot.onrender.com or public Cloud Run URL).',
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      error: 'Invalid URL format. Include https:// (for example: https://my-ca-bot.onrender.com).',
    };
  }
  if (parsed.protocol !== 'https:') {
    return {
      ok: false,
      error: 'Telegram Webhooks strictly require an HTTPS URL (http:// is rejected by Telegram).',
    };
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host.endsWith('.local') ||
    host.startsWith('192.168.') ||
    host.startsWith('10.')
  ) {
    return {
      ok: false,
      error: 'Localhost / private IP URLs cannot receive Telegram Webhooks from the internet.',
    };
  }
  if (host.startsWith('ais-dev-')) {
    return {
      ok: false,
      error:
        'ais-dev-* is the temporary Google AI Studio editor preview (it requires Google login and sleeps when AI Studio closes). Deploy the app publicly (Render, Railway, Cloud Run with unauthenticated access, or Python Bot ZIP) and paste that public HTTPS URL instead.',
    };
  }
  let cleanPath = parsed.pathname.replace(/\/+$/, '');
  cleanPath = cleanPath.replace(/\/api\/telegram\/webhook(?:\/.*)?$/i, '');
  const baseUrl = `${parsed.origin}${cleanPath}`;
  return {
    ok: true,
    baseUrl,
    webhookEndpoint: `${baseUrl}/api/telegram/webhook`,
  };
}



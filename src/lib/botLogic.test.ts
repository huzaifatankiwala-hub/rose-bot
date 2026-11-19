import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOT_GROUP_ADDED_GREETING,
  DEFAULT_WELCOME_TEXT,
  buildMtprotoAdminRights,
  buildTagAllChunks,
  buildTagAllMessage,
  chunkTelegramText,
  computeSessionCooldownRemaining,
  evaluateBotAdminPermissions,
  evaluatePromoteBotRights,
  extractMuteMinutes,
  formatBotGroupAddedGreeting,
  formatTelegramModErrorHtml,
  formatWmoWeather,
  isBotMentionedOrReplied,
  isCasualAckOrGreeting,
  isFreshSessionAdminError,
  isNonCaSentinelOrRefusal,
  isTelegramAdminLockError,
  isTransientTimeoutOrNetworkError,
  normalizeWebhookBaseUrl,
  parseCommand,
  parseDurationMinutes,
  parseGeminiErrorDetails,
  renderWelcomeMessage,
  resolveTargetMember,
  resolveTargetWithArgs,
  stripBotMention,
  validateModerationTarget,
  withTimeout,
} from './botLogic';
import { buildZipArchiveBytes } from './zipExport';
import type { GroupMember } from '../types';

const sampleMembers: GroupMember[] = [
  {
    chat_id: -1001,
    user_id: 101,
    username: 'ca_meera',
    full_name: 'Meera Nair',
    role: 'owner',
    is_bot: false,
    is_active: true,
    is_muted: false,
    muted_until: null,
    msg_count: 15,
    warns: 0,
    first_seen: '2026-11-01 10:00 UTC',
    last_seen: '2026-11-16 09:00 UTC',
    avatar_url: null,
  },
  {
    chat_id: -1001,
    user_id: 102,
    username: 'rohan_ca',
    full_name: 'Rohan Verma',
    role: 'member',
    is_bot: false,
    is_active: true,
    is_muted: false,
    muted_until: null,
    msg_count: 8,
    warns: 1,
    first_seen: '2026-11-02 11:00 UTC',
    last_seen: '2026-11-16 08:00 UTC',
    avatar_url: null,
  },
  {
    chat_id: -1001,
    user_id: 103,
    username: 'inactive_user',
    full_name: 'Banned User',
    role: 'member',
    is_bot: false,
    is_active: false,
    is_muted: false,
    muted_until: null,
    msg_count: 2,
    warns: 3,
    first_seen: '2026-11-03 12:00 UTC',
    last_seen: '2026-11-05 12:00 UTC',
    avatar_url: null,
  },
  {
    chat_id: -1001,
    user_id: 9000001,
    username: 'CA_Rose_Bot',
    full_name: 'CA Rose Guider',
    role: 'administrator',
    is_bot: true,
    is_active: true,
    is_muted: false,
    muted_until: null,
    msg_count: 20,
    warns: 0,
    first_seen: '2026-11-01 09:00 UTC',
    last_seen: '2026-11-16 09:05 UTC',
    avatar_url: null,
  },
];

test('parseCommand extracts command with optional bot suffix and args', () => {
  const cmd1 = parseCommand('/weather New Delhi');
  assert.deepEqual(cmd1, { command: 'weather', args: ['New', 'Delhi'], rawArgs: 'New Delhi' });

  const cmd2 = parseCommand('/tagall@CA_Rose_Bot Revision session at 8pm');
  assert.deepEqual(cmd2, {
    command: 'tagall',
    args: ['Revision', 'session', 'at', '8pm'],
    rawArgs: 'Revision session at 8pm',
  });

  assert.equal(parseCommand('hello @CA_Rose_Bot'), null);
});

test('buildTagAllMessage excludes bots and inactive members and uses @username when present', () => {
  const result = buildTagAllMessage(sampleMembers, 'Mock Test Tonight');
  assert.equal(result.mode, 'full');
  assert.equal(result.taggedCount, 2);
  assert.equal(result.totalCount, 2);
  assert.equal(result.chunkCount, 1);
  assert.ok(result.htmlText.includes('@ca_meera'));
  assert.ok(result.htmlText.includes('@rohan_ca'));
  assert.ok(!result.htmlText.includes('Banned User'));
  assert.ok(!result.htmlText.includes('CA Rose Guider'));
  assert.ok(result.charLength <= 4096);
});

test('buildTagAllChunks packs medium groups in 1 single message and splits mega groups without dropping members', () => {
  const mediumGroup = Array.from({ length: 85 }, (_, idx) => ({
    user_id: 4000 + idx,
    username: idx % 3 === 0 ? `ca_student_${idx}` : null,
    full_name: `CA Student ${idx} Longname`,
    is_active: true,
    is_bot: false,
  }));
  const singleMsgRes = buildTagAllChunks(mediumGroup, 'Important Announcement');
  assert.equal(singleMsgRes.totalCount, 85);
  assert.equal(singleMsgRes.chunkCount, 1);
  assert.equal(singleMsgRes.chunks[0].count, 85);

  const largeGroup = Array.from({ length: 162 }, (_, idx) => ({
    user_id: 5000 + idx,
    username: idx % 2 === 0 ? `ca_student_${idx}` : null,
    full_name: `CA Student ${idx}`,
    is_active: true,
    is_bot: false,
  }));

  const defaultLargeRes = buildTagAllChunks(largeGroup, 'Mega Revision');
  assert.equal(defaultLargeRes.totalCount, 162);
  assert.equal(defaultLargeRes.chunkCount, 2); // 100 + 62
  assert.equal(defaultLargeRes.chunks[0].count + defaultLargeRes.chunks[1].count, 162);

  const chunkedRes = buildTagAllChunks(largeGroup, 'Mega Revision', 3800, 5);
  assert.equal(chunkedRes.totalCount, 162);
  assert.equal(chunkedRes.chunkCount, 33); // ceil(162 / 5)
  assert.equal(chunkedRes.chunks[0].count, 5);
  assert.equal(chunkedRes.chunks[32].count, 2);
  assert.ok(chunkedRes.chunks[0].htmlText.includes('(1/33)'));
  assert.ok(chunkedRes.chunks.every((c) => c.htmlText.length <= 4096));
  const summed = chunkedRes.chunks.reduce((acc, c) => acc + c.count, 0);
  assert.equal(summed, 162);
});

test('evaluateBotAdminPermissions explicitly lists missing and granted permissions', () => {
  const nonAdminCheck = evaluateBotAdminPermissions(
    { status: 'member' },
    ['can_delete_messages', 'can_restrict_members'],
    'tagall'
  );
  assert.equal(nonAdminCheck.ok, false);
  assert.equal(nonAdminCheck.isAdmin, false);
  assert.ok(nonAdminCheck.debugPlain.includes('Delete Messages'));
  assert.ok(nonAdminCheck.debugPlain.includes('Ban Users'));

  const partialAdminCheck = evaluateBotAdminPermissions(
    { status: 'administrator', can_delete_messages: true, can_restrict_members: false },
    ['can_delete_messages', 'can_restrict_members'],
    'tagall'
  );
  assert.equal(partialAdminCheck.ok, false);
  assert.equal(partialAdminCheck.isAdmin, true);
  assert.deepEqual(partialAdminCheck.missingLabels, ['Ban Users (Restrict Members)']);

  const fullAdminCheck = evaluateBotAdminPermissions(
    { status: 'administrator', can_delete_messages: true, can_restrict_members: true },
    ['can_delete_messages', 'can_restrict_members'],
    'tagall'
  );
  assert.equal(fullAdminCheck.ok, true);
  assert.deepEqual(fullAdminCheck.missingLabels, []);
});

test('renderWelcomeMessage replaces placeholders safely in plain and html modes', () => {
  const member = { user_id: 42, full_name: 'Aarav <CA>', username: 'aarav_ca' };
  const htmlRendered = renderWelcomeMessage(DEFAULT_WELCOME_TEXT, member, 'CA & Tax Group', 'html');
  assert.equal(
    htmlRendered,
    'Hello Aarav &lt;CA&gt;! How are you doing? Welcome to CA &amp; Tax Group!'
  );
  assert.equal(htmlRendered.includes('tg://user'), false);
  assert.equal(htmlRendered.includes('@aarav_ca'), false);

  const plainRendered = renderWelcomeMessage(DEFAULT_WELCOME_TEXT, member, 'CA Hub', 'plain');
  assert.equal(plainRendered, 'Hello Aarav <CA>! How are you doing? Welcome to CA Hub!');
  assert.equal(plainRendered.includes('@aarav_ca'), false);

  const groupAdded = formatBotGroupAddedGreeting('CA Final Nov 26');
  assert.equal(groupAdded, 'Hello everyone! How are you all doing? Happy to join CA Final Nov 26!');
  assert.equal(BOT_GROUP_ADDED_GREETING.toLowerCase().includes('botfather'), false);
  assert.equal(BOT_GROUP_ADDED_GREETING.includes('How are you'), true);
});

test('isBotMentionedOrReplied and stripBotMention handle group mentions and replies', () => {
  assert.equal(isBotMentionedOrReplied('Hey @ca_rose_bot explain Ind AS 116', 'CA_Rose_Bot', false, false), true);
  assert.equal(isBotMentionedOrReplied('Random chat message', 'CA_Rose_Bot', false, false), false);
  assert.equal(isBotMentionedOrReplied('Follow up question', 'CA_Rose_Bot', true, false), true);
  assert.equal(stripBotMention('@CA_Rose_Bot Explain Section 44AD', 'CA_Rose_Bot'), 'Explain Section 44AD');
});

test('resolveTargetMember, parseDurationMinutes, and extractMuteMinutes handle reply, username, ID, and units', () => {
  const byReply = resolveTargetMember([], 102, sampleMembers);
  assert.equal(byReply?.username, 'rohan_ca');

  const byUsername = resolveTargetMember(['@ROHAN_CA', '30'], null, sampleMembers);
  assert.equal(byUsername?.user_id, 102);

  const byId = resolveTargetMember(['102', '45'], null, sampleMembers);
  assert.equal(byId?.user_id, 102);

  assert.equal(parseDurationMinutes('30'), 30);
  assert.equal(parseDurationMinutes('30m'), 30);
  assert.equal(parseDurationMinutes('2h'), 120);
  assert.equal(parseDurationMinutes('1d'), 1440);
  assert.equal(extractMuteMinutes(['102', '45'], false, 102), 45);
  assert.equal(extractMuteMinutes(['@rohan_ca', '2h'], false, 102), 120);
  assert.equal(extractMuteMinutes(['30m'], true, 102), 30);
});

test('formatWmoWeather and chunkTelegramText work as expected', () => {
  assert.equal(formatWmoWeather(0), 'Clear sky');
  assert.equal(formatWmoWeather(999), 'Weather update');
  assert.deepEqual(chunkTelegramText('abcde', 2), ['ab', 'cd', 'e']);
});

test('isCasualAckOrGreeting and isNonCaSentinelOrRefusal prevent repeated CA-only spam', () => {
  assert.equal(isCasualAckOrGreeting('ok'), true);
  assert.equal(isCasualAckOrGreeting('Thanks!'), true);
  assert.equal(isCasualAckOrGreeting('👍'), true);
  assert.equal(isCasualAckOrGreeting('Explain Ind AS 116'), false);

  assert.equal(isNonCaSentinelOrRefusal('[NON_CA_QUERY]'), true);
  assert.equal(
    isNonCaSentinelOrRefusal('I am strictly specialized in CA exam guidance only.'),
    true
  );
  assert.equal(
    isNonCaSentinelOrRefusal('Under Section 44AD of the Income-tax Act, 1961...'),
    false
  );
});

test('resolveTargetWithArgs, evaluatePromoteBotRights, and validateModerationTarget verify target context and rights', () => {
  const res = resolveTargetWithArgs(['30m', '@rohan_ca'], null, sampleMembers);
  assert.equal(res.member?.user_id, 102);
  assert.deepEqual(res.remainingArgs, ['30m']);

  const promoteEmpty = evaluatePromoteBotRights({
    status: 'administrator',
    can_promote_members: true,
    can_manage_chat: false,
    can_delete_messages: false,
    can_restrict_members: false,
    can_invite_users: false,
    can_pin_messages: false,
  });
  assert.equal(promoteEmpty.ok, false);

  const promoteOk = evaluatePromoteBotRights({
    status: 'administrator',
    can_promote_members: true,
    can_delete_messages: true,
  });
  assert.equal(promoteOk.ok, true);
  assert.equal(promoteOk.rights.can_delete_messages, true);

  assert.equal(
    validateModerationTarget({
      action: 'ban',
      actorId: 101,
      botId: 9000001,
      targetId: 101,
      targetName: 'Meera',
      targetStatus: 'creator',
    }).allowed,
    false
  );
  assert.equal(
    validateModerationTarget({
      action: 'promote',
      actorId: 101,
      botId: 9000001,
      targetId: 103,
      targetName: 'Banned User',
      targetStatus: 'kicked',
    }).allowed,
    false
  );
  const demoteLocked = validateModerationTarget({
    action: 'demote',
    actorId: 101,
    botId: 9000001,
    targetId: 202,
    targetName: 'Old Admin',
    targetStatus: 'administrator',
    targetCanBeEdited: false,
  });
  assert.equal(demoteLocked.allowed, false);
  assert.equal(demoteLocked.ownerLocked, true);
});

test('isTelegramAdminLockError and buildMtprotoAdminRights support owner override demotion and promotion', async () => {
  assert.equal(isTelegramAdminLockError('Bad Request: CHAT_ADMIN_REQUIRED'), true);
  assert.equal(isTelegramAdminLockError('403 RIGHT_FORBIDDEN'), true);
  assert.equal(isTelegramAdminLockError('Bad Request: not enough rights'), true);
  assert.equal(isTelegramAdminLockError('Network timeout'), false);

  const demoteFlags = buildMtprotoAdminRights(false);
  assert.equal(Object.values(demoteFlags).every((v) => v === false), true);

  const promoteFlags = buildMtprotoAdminRights(true, {
    can_manage_chat: true,
    can_delete_messages: true,
    can_manage_video_chats: false,
    can_restrict_members: true,
    can_invite_users: false,
    can_pin_messages: true,
  });
  assert.equal(promoteFlags.deleteMessages, true);
  assert.equal(promoteFlags.banUsers, true);
  assert.equal(promoteFlags.pinMessages, true);
  assert.equal(promoteFlags.manageCall, false);
  assert.equal(promoteFlags.addAdmins, false);

  assert.equal(isFreshSessionAdminError('406: FRESH_CHANGE_ADMINS_FORBIDDEN'), true);
  assert.equal(isFreshSessionAdminError('CHAT_ADMIN_REQUIRED'), false);

  const now = Date.parse('2026-11-16T12:00:00Z');
  const activeCooldown = computeSessionCooldownRemaining('2026-11-16T11:30:00Z', now);
  assert.equal(activeCooldown.inCooldown, true);
  assert.equal(activeCooldown.label, '23h 30m');

  const expiredCooldown = computeSessionCooldownRemaining('2026-11-15T11:00:00Z', now);
  assert.equal(expiredCooldown.inCooldown, false);
  assert.equal(expiredCooldown.label, null);

  assert.equal(
    isTransientTimeoutOrNetworkError(new Error('The operation was aborted due to timeout')),
    true
  );
  assert.equal(isTransientTimeoutOrNetworkError(new Error('fetch failed')), true);
  assert.equal(isTransientTimeoutOrNetworkError(new Error('Unauthorized: invalid bot token')), false);

  await assert.rejects(
    withTimeout(new Promise((r) => setTimeout(r, 200)), 15, 'Slow test'),
    /timed out/
  );

  const err503 = parseGeminiErrorDetails(
    new Error(
      '{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}'
    )
  );
  assert.equal(err503.code, 503);
  assert.equal(err503.retryable, true);
  assert.equal(err503.shouldFallbackModel, true);
  assert.equal(err503.friendlyMessage.includes('{'), false);

  const err403 = parseGeminiErrorDetails(
    new Error('{"error":{"code":403,"message":"API_KEY_INVALID","status":"PERMISSION_DENIED"}}')
  );
  assert.equal(err403.code, 403);
  assert.equal(err403.retryable, false);
  assert.equal(err403.friendlyMessage.includes('GEMINI_API_KEY'), true);

  const punctuated = resolveTargetWithArgs(['@Rohan_CA,', '30min'], null, sampleMembers);
  assert.equal(punctuated.member?.user_id, 102);
  assert.equal(punctuated.mentionUsername, 'rohan_ca');
  assert.equal(extractMuteMinutes(punctuated.remainingArgs, punctuated.resolvedFromReply, 102), 30);

  const unseen = resolveTargetWithArgs(['@new_student', '2hrs'], null, sampleMembers, {
    botUsername: 'CA_Rose_Bot',
  });
  assert.equal(unseen.member, null);
  assert.equal(unseen.mentionUsername, 'new_student');
  assert.equal(parseDurationMinutes('2hrs'), 120);
  assert.equal(parseDurationMinutes('1day'), 1440);

  const botMentionFirst = resolveTargetWithArgs(['@CA_Rose_Bot', '@Rohan_CA', '10m'], null, sampleMembers, {
    botUsername: 'CA_Rose_Bot',
  });
  assert.equal(botMentionFirst.member?.user_id, 102);

  assert.ok(
    formatTelegramModErrorHtml('ban', '<b>Rohan</b>', new Error('Bad Request: USER_ADMIN_INVALID')).includes('/demote')
  );
  assert.ok(
    formatTelegramModErrorHtml('delete', null, new Error("Bad Request: message can't be deleted for everyone"), 'del').includes('48 hours')
  );
  assert.ok(
    formatTelegramModErrorHtml('ban', '<b>Rohan</b>', new Error('Bad Request: not enough rights to restrict/unrestrict chat member'), 'tban').includes('/tban')
  );
  assert.ok(
    formatTelegramModErrorHtml('unban', '<b>Rohan</b>', new Error('Bad Request: CHAT_NOT_MODIFIED')).includes('already')
  );

  assert.equal(normalizeWebhookBaseUrl('http://example.com').ok, false);
  assert.equal(normalizeWebhookBaseUrl('https://localhost:3000').ok, false);
  const aisDev = normalizeWebhookBaseUrl('https://ais-dev-123.asia-northeast1.run.app');
  assert.equal(aisDev.ok, false);
  assert.ok(aisDev.error?.includes('ais-dev-'));

  const validHook = normalizeWebhookBaseUrl('https://my-ca-bot.onrender.com/api/telegram/webhook/');
  assert.equal(validHook.ok, true);
  assert.equal(validHook.baseUrl, 'https://my-ca-bot.onrender.com');
  assert.equal(validHook.webhookEndpoint, 'https://my-ca-bot.onrender.com/api/telegram/webhook');

  const zipBytes = buildZipArchiveBytes([
    { name: 'bot.py', content: 'print("hello")\n' },
    { name: 'requirements.txt', content: 'python-telegram-bot==21.10\n' },
  ]);
  assert.equal(zipBytes[0], 0x50); // 'P'
  assert.equal(zipBytes[1], 0x4b); // 'K'
  assert.ok(zipBytes.length > 100);
});

import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import {
  BOT_USER_ID,
  BOT_USERNAME_DEFAULT,
  CA_ONE_TIME_NOTICE,
  buildTagAllChunks,
  extractMuteMinutes,
  formatWmoWeather,
  isBotMentionedOrReplied,
  isCasualAckOrGreeting,
  isNonCaSentinelOrRefusal,
  parseCommand,
  parseGeminiErrorDetails,
  renderWelcomeMessage,
  resolveTargetWithArgs,
  stripBotMention,
  validateModerationTarget,
  withTimeout,
} from '../lib/botLogic';
import type { ChatMessage, GroupMember, WeatherResult } from '../types';
import { botDb, DEFAULT_CHAT_ID } from './db';

export const CA_SYSTEM_INSTRUCTION = `
You are an expert Chartered Accountancy (CA) Exam Mentor & Study Guider specializing STRICTLY in CA studies (ICAI syllabus: CA Foundation, CA Intermediate, CA Final, and Articleship/practical training).

STRICT DOMAIN RULES:
1. You ONLY answer questions related to Chartered Accountancy (CA) exams, CA syllabus subjects (Accounting, Ind AS, Corporate & Other Laws, Direct & Indirect Taxation / GST, Cost & Management Accounting, Auditing & Ethics, Financial Management, Strategic Management, AFM, IBS), CA exam preparation strategies, ICAI study material, RTPs/MTPs/Past Papers, revision plans, memory techniques, and exam writing tips.
2. If the user sends a voice/audio message, listen carefully to what they said (question, doubt, spoken answer for evaluation, or study request).
   - If it is a CA question or spoken CA answer/concept explanation, evaluate or answer it accurately with section numbers, Accounting Standards / Ind AS / SAs references where relevant, and exam presentation tips.
   - If the audio or text is NOT related to CA studies/exams (e.g., general coding, movies, gossip, casual chat, non-CA subjects), respond with EXACTLY the single token: [NON_CA_QUERY] and nothing else.
3. Keep formatting clean and easy to read in Telegram (use short headings, bullet points, and clear steps; avoid massive raw markdown tables).
4. Note clearly whenever a tax provision depends on the Finance Act / Assessment Year, and guide them accordingly.
`.trim();

const PRIMARY_GEMINI_MODEL = process.env.GEMINI_MODEL?.trim() || 'gemini-4-hydrogen';
const FALLBACK_GEMINI_MODEL = 'gemini-3.1-flash-lite';

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in server secrets.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function buildModelAttemptPlan(): Array<{ model: string; thinkingLevel?: ThinkingLevel; timeoutMs: number }> {
  const models = Array.from(
    new Set([PRIMARY_GEMINI_MODEL, 'gemini-4-hydrogen', FALLBACK_GEMINI_MODEL].filter(Boolean))
  );
  const firstPass = models.map((model) => ({
    model,
    thinkingLevel: model.startsWith('gemini-4-') ? ThinkingLevel.LOW : undefined,
    timeoutMs: 14000,
  }));
  // One final quick retry on fallback if first pass suffered transient 503/network spike
  return [
    ...firstPass,
    {
      model: FALLBACK_GEMINI_MODEL,
      timeoutMs: 14000,
    },
  ];
}

export async function askGeminiCA(params: {
  promptText: string;
  audioBase64?: string;
  audioMime?: string;
}): Promise<string> {
  const ai = getGeminiClient();
  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];

  if (params.audioBase64) {
    parts.push({
      inlineData: {
        mimeType: params.audioMime || 'audio/ogg',
        data: params.audioBase64,
      },
    });
  }

  let userPrompt = params.promptText.trim();
  if (!userPrompt && params.audioBase64) {
    userPrompt =
      'Listen to this audio carefully and respond as my CA exam study guider. If the speaker asks a CA doubt, answer it clearly. If they are reciting a CA answer/concept, evaluate and correct it.';
  }
  parts.push({ text: userPrompt });

  const plan = buildModelAttemptPlan();
  let lastParsedErr: ReturnType<typeof parseGeminiErrorDetails> | null = null;

  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    try {
      const response = await withTimeout(
        ai.models.generateContent({
          model: step.model,
          contents: { parts },
          config: {
            systemInstruction: CA_SYSTEM_INSTRUCTION,
            ...(step.thinkingLevel
              ? { thinkingConfig: { thinkingLevel: step.thinkingLevel } }
              : {}),
          },
        }),
        step.timeoutMs,
        `Gemini (${step.model})`
      );

      const text = (response.text ?? '').trim();
      if (text) {
        return text;
      }
      return 'I could not generate a response. Please try again.';
    } catch (err) {
      const details = parseGeminiErrorDetails(err);
      lastParsedErr = details;
      console.warn(
        `[GeminiCA] Attempt ${i + 1}/${plan.length} (${step.model}) failed (code=${details.code ?? 'n/a'}):`,
        details.message
      );

      if (!details.shouldFallbackModel) {
        throw new Error(details.friendlyMessage);
      }

      if (i < plan.length - 1) {
        const backoffMs = i >= plan.length - 2 ? 800 : 300;
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }

  throw new Error(
    lastParsedErr?.friendlyMessage || 'Gemini AI is temporarily unavailable. Please try again shortly.'
  );
}

export async function fetchWeatherForCity(city: string): Promise<WeatherResult> {
  const cleanCity = city.trim();
  if (!cleanCity) {
    throw new Error('Please provide a city name, e.g. /weather Delhi.');
  }

  const geoUrl = new URL('https://geocoding-api.open-meteo.com/v1/search');
  geoUrl.searchParams.set('name', cleanCity);
  geoUrl.searchParams.set('count', '1');
  geoUrl.searchParams.set('language', 'en');
  geoUrl.searchParams.set('format', 'json');

  const geoResp = await fetch(geoUrl.toString(), { signal: AbortSignal.timeout(10000) });
  if (!geoResp.ok) {
    throw new Error(`Geocoding service failed (${geoResp.status}).`);
  }
  const geoData = (await geoResp.json()) as {
    results?: Array<{
      name?: string;
      admin1?: string;
      country?: string;
      latitude: number;
      longitude: number;
    }>;
  };

  const loc = geoData.results?.[0];
  if (!loc) {
    throw new Error(`Could not find city: ${cleanCity}`);
  }

  const place = [loc.name, loc.admin1, loc.country].filter(Boolean).join(', ');
  const wxUrl = new URL('https://api.open-meteo.com/v1/forecast');
  wxUrl.searchParams.set('latitude', String(loc.latitude));
  wxUrl.searchParams.set('longitude', String(loc.longitude));
  wxUrl.searchParams.set(
    'current',
    'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m'
  );
  wxUrl.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min');
  wxUrl.searchParams.set('timezone', 'auto');
  wxUrl.searchParams.set('forecast_days', '1');

  const wxResp = await fetch(wxUrl.toString(), { signal: AbortSignal.timeout(10000) });
  if (!wxResp.ok) {
    throw new Error(`Weather forecast failed (${wxResp.status}).`);
  }
  const wxData = (await wxResp.json()) as {
    current: {
      temperature_2m: number;
      apparent_temperature: number;
      relative_humidity_2m: number;
      weather_code: number;
      wind_speed_10m: number;
    };
    daily: {
      temperature_2m_max: number[];
      temperature_2m_min: number[];
    };
  };

  const weatherCode = Number(wxData.current.weather_code ?? -1);
  return {
    place,
    condition: formatWmoWeather(weatherCode),
    weatherCode,
    temperatureC: wxData.current.temperature_2m,
    apparentTemperatureC: wxData.current.apparent_temperature,
    minTempC: wxData.daily.temperature_2m_min[0],
    maxTempC: wxData.daily.temperature_2m_max[0],
    humidityPct: wxData.current.relative_humidity_2m,
    windKmh: wxData.current.wind_speed_10m,
  };
}

function isSenderAdmin(member: GroupMember): boolean {
  return member.role === 'owner' || member.role === 'administrator';
}

function addBotReply(
  chatId: number,
  text: string,
  replyToId: number | null,
  replyToSnippet: string | null,
  messageType: ChatMessage['message_type'] = 'bot_reply'
): ChatMessage {
  return botDb.addMessage({
    chatId,
    senderId: BOT_USER_ID,
    senderName: 'CA Rose Guider',
    senderUsername: BOT_USERNAME_DEFAULT,
    senderRole: 'administrator',
    isBot: true,
    text,
    replyToId,
    replyToSnippet,
    messageType,
  });
}

export async function processSimulatorMessage(params: {
  chatId?: number;
  senderId: number;
  text: string;
  replyToId?: number | null;
  audioBase64?: string;
  audioMime?: string;
  audioName?: string;
}): Promise<{ userMessage: ChatMessage; botMessages: ChatMessage[] }> {
  const chatId = params.chatId ?? DEFAULT_CHAT_ID;
  const sender = botDb.getMember(chatId, params.senderId);
  if (!sender) {
    throw new Error('Selected sender was not found in this group.');
  }
  if (!sender.is_active) {
    throw new Error(`${sender.full_name} is currently banned/inactive and cannot send messages until unbanned.`);
  }
  if (sender.is_muted) {
    if (sender.muted_until) {
      const expiresAt = Date.parse(sender.muted_until.replace(' UTC', 'Z').replace(' ', 'T'));
      if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
        botDb.setMemberMuted(chatId, sender.user_id, false, null);
        sender.is_muted = false;
        sender.muted_until = null;
      }
    }
    if (sender.is_muted) {
      throw new Error(`${sender.full_name} is muted in this group. Unmute them to send messages.`);
    }
  }

  const replyTargetMsg = params.replyToId ? botDb.getMessageById(params.replyToId) : null;
  const replySnippet = replyTargetMsg
    ? `${replyTargetMsg.sender_name}: ${replyTargetMsg.text.slice(0, 80)}`
    : null;

  const trimmedText = params.text.trim();
  const parsed = parseCommand(trimmedText);

  const updatedSender = botDb.upsertMember({
    chatId,
    userId: sender.user_id,
    username: sender.username,
    fullName: sender.full_name,
    role: sender.role,
    isBot: sender.is_bot,
    isActive: true,
    incrementMsg: true,
  });

  const userMessage = botDb.addMessage({
    chatId,
    senderId: updatedSender.user_id,
    senderName: updatedSender.full_name,
    senderUsername: updatedSender.username,
    senderRole: updatedSender.role,
    isBot: false,
    text: trimmedText || (params.audioName ? `[Voice/Audio: ${params.audioName}]` : ''),
    replyToId: replyTargetMsg?.id ?? null,
    replyToSnippet: replySnippet,
    audioName: params.audioName ?? null,
    audioMime: params.audioMime ?? null,
    messageType: parsed ? 'command' : 'chat',
  });

  const botMessages: ChatMessage[] = [];
  const settings = botDb.getGroupSettings(chatId);
  const allMembers = botDb.getMembers(chatId);

  if (parsed) {
    const cmd = parsed.command;
    const senderIsAdmin = isSenderAdmin(updatedSender);
    const replyUserId = replyTargetMsg ? replyTargetMsg.sender_id : null;
    const targetRes = resolveTargetWithArgs(parsed.args, replyUserId, allMembers, {
      botUsername: BOT_USERNAME_DEFAULT,
    });
    const targetMember = targetRes.member;
    const unresolvedMentionMsg = targetRes.mentionUsername
      ? `Could not find @${targetRes.mentionUsername} in this group's roster. Select an existing member or check their handle.`
      : null;
    const checkSimTarget = (action: 'ban' | 'unban' | 'kick' | 'mute' | 'unmute' | 'promote' | 'demote' | 'warn') => {
      if (!targetMember) {
        return { allowed: false, reason: unresolvedMentionMsg || `Reply to a user or provide @username/ID to ${action}.` };
      }
      const simStatus = !targetMember.is_active
        ? 'kicked'
        : targetMember.role === 'owner'
          ? 'creator'
          : targetMember.role === 'administrator'
            ? 'administrator'
            : 'member';
      return validateModerationTarget({
        action,
        actorId: updatedSender.user_id,
        botId: BOT_USER_ID,
        targetId: targetMember.user_id,
        targetName: targetMember.full_name,
        targetStatus: simStatus,
        targetIsBot: targetMember.is_bot,
        targetCanBeEdited: true,
      });
    };

    switch (cmd) {
      case 'start': {
        botMessages.push(
          addBotReply(
            chatId,
            `Hello! I am CA Rose Guider (@${BOT_USERNAME_DEFAULT}).\n\nI combine Rose-style Group Management, Single-Message /tagall, Live /weather, Admin /info, and a CA-Specialized Gemini AI Study Guider (text & voice/audio).\n\nUse /help to view all commands.`,
            userMessage.id,
            trimmedText
          )
        );
        break;
      }
      case 'help': {
        botMessages.push(
          addBotReply(
            chatId,
            `Bot Command Guide:\n• CA Study Guider: Mention @${BOT_USERNAME_DEFAULT} with text or audio/voice\n• /tagall [note] — Tag all group members in one message (Admin)\n• /ban, /tban <time>, /unban, /kick, /mute [30m|2h|1d], /tmute, /unmute (Admin)\n• /promote [title], /demote, /adminlist (Admin)\n• /warn, /warns, /resetwarns, /del, /pin, /unpin (Admin)\n• /setwelcome <text>, /welcome on|off, /setrules <text>, /rules\n• /info (reply / @username / user_id) — Admin only\n• /weather <city> — Live Open-Meteo weather report\n• /id — Inspect Chat & User ID`,
            userMessage.id,
            trimmedText
          )
        );
        break;
      }
      case 'id': {
        if (unresolvedMentionMsg && !targetMember) {
          botMessages.push(addBotReply(chatId, unresolvedMentionMsg, userMessage.id, trimmedText));
          break;
        }
        const who = targetMember ?? updatedSender;
        botMessages.push(
          addBotReply(
            chatId,
            `Chat ID: ${chatId}\nUser ID: ${who.user_id} (${who.full_name})`,
            userMessage.id,
            trimmedText,
            'info'
          )
        );
        break;
      }
      case 'weather': {
        if (!parsed.rawArgs) {
          botMessages.push(
            addBotReply(chatId, 'Usage: /weather Delhi', userMessage.id, trimmedText)
          );
          break;
        }
        try {
          const wx = await fetchWeatherForCity(parsed.rawArgs);
          const reply = `Weather in ${wx.place}\n• Condition: ${wx.condition}\n• Temperature: ${wx.temperatureC}°C (Feels like ${wx.apparentTemperatureC}°C)\n• Min / Max: ${wx.minTempC}°C / ${wx.maxTempC}°C\n• Humidity: ${wx.humidityPct}%\n• Wind: ${wx.windKmh} km/h`;
          botMessages.push(
            addBotReply(chatId, reply, userMessage.id, trimmedText, 'weather')
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unable to fetch weather.';
          botMessages.push(addBotReply(chatId, `Weather error: ${message}`, userMessage.id, trimmedText));
        }
        break;
      }
      case 'tagall': {
        if (!senderIsAdmin) {
          botMessages.push(
            addBotReply(chatId, 'Only group admins can use /tagall.', userMessage.id, trimmedText)
          );
          break;
        }
        const chunked = buildTagAllChunks(allMembers, parsed.rawArgs);
        for (const chunk of chunked.chunks) {
          const footer =
            chunked.totalCount > 0
              ? `\n\n[Chunk ${chunk.chunkIndex}/${chunk.totalChunks} · ${chunk.count} mentions · ${chunk.htmlText.length}/4096 chars]`
              : '';
          botMessages.push(
            addBotReply(chatId, chunk.text + footer, userMessage.id, trimmedText, 'tagall')
          );
        }
        break;
      }
      case 'adminlist':
      case 'admins': {
        const admins = allMembers.filter((m) => !m.is_bot && (m.role === 'owner' || m.role === 'administrator'));
        const list = admins.map((a) => `• ${a.full_name} (${a.role})`).join('\n');
        botMessages.push(
          addBotReply(
            chatId,
            `Group Admins (${admins.length}):\n${list}\n\nBot Permissions: ✅ Admin Role · ✅ Delete Messages · ✅ Ban Users · ✅ Pin Messages · ✅ Add Admins`,
            userMessage.id,
            trimmedText,
            'info'
          )
        );
        break;
      }
      case 'info': {
        if (!senderIsAdmin) {
          botMessages.push(
            addBotReply(chatId, 'Only group admins can check member info.', userMessage.id, trimmedText)
          );
          break;
        }
        if (!targetMember) {
          botMessages.push(
            addBotReply(
              chatId,
              unresolvedMentionMsg || 'Usage: Reply to a user with /info or pass /info @username or /info 1001003.',
              userMessage.id,
              trimmedText
            )
          );
          break;
        }
        const statusText = !targetMember.is_active
          ? 'Banned / Left'
          : targetMember.is_muted
            ? `Muted${targetMember.muted_until ? ` until ${targetMember.muted_until}` : ''}`
            : 'Active';
        const infoText = `User Information\n• Name: ${targetMember.full_name}\n• User ID: ${targetMember.user_id}\n• Username: ${targetMember.username ? '@' + targetMember.username : 'None'}\n• Group Role: ${targetMember.role.charAt(0).toUpperCase() + targetMember.role.slice(1)}\n• Status: ${statusText}\n• Is Bot: ${targetMember.is_bot ? 'Yes' : 'No'}\n• Warnings: ${targetMember.warns}/${settings.max_warns}\n• Tracked Messages: ${targetMember.msg_count}\n• First Seen: ${targetMember.first_seen}\n• Last Seen: ${targetMember.last_seen}`;
        botMessages.push(
          addBotReply(chatId, infoText, userMessage.id, trimmedText, 'info')
        );
        break;
      }
      case 'ban':
      case 'tban': {
        if (!senderIsAdmin) {
          botMessages.push(addBotReply(chatId, `You must be a group admin to use /${cmd}.`, userMessage.id, trimmedText));
          break;
        }
        const v = checkSimTarget('ban');
        if (!v.allowed || !targetMember) {
          botMessages.push(addBotReply(chatId, v.reason || 'Cannot ban target.', userMessage.id, trimmedText));
          break;
        }
        const mins = extractMuteMinutes(targetRes.remainingArgs, targetRes.resolvedFromReply, targetMember.user_id);
        if (cmd === 'tban' && !mins) {
          botMessages.push(
            addBotReply(
              chatId,
              'Usage: /tban @user <time> (e.g. 30m, 2h, 1d). Use /ban for a permanent ban.',
              userMessage.id,
              trimmedText
            )
          );
          break;
        }
        botDb.setMemberActive(chatId, targetMember.user_id, false);
        botMessages.push(
          addBotReply(
            chatId,
            `Banned ${targetMember.full_name}${mins ? ` for ${mins} min` : ''}.`,
            userMessage.id,
            trimmedText
          )
        );
        break;
      }
      case 'unban': {
        if (!senderIsAdmin) {
          botMessages.push(addBotReply(chatId, 'You must be a group admin to use /unban.', userMessage.id, trimmedText));
          break;
        }
        const v = checkSimTarget('unban');
        if (!v.allowed || !targetMember) {
          botMessages.push(addBotReply(chatId, v.reason || 'Cannot unban target.', userMessage.id, trimmedText));
          break;
        }
        botDb.setMemberActive(chatId, targetMember.user_id, true);
        botMessages.push(addBotReply(chatId, `Unbanned ${targetMember.full_name}.`, userMessage.id, trimmedText));
        break;
      }
      case 'kick': {
        if (!senderIsAdmin) {
          botMessages.push(addBotReply(chatId, 'You must be a group admin to use /kick.', userMessage.id, trimmedText));
          break;
        }
        const v = checkSimTarget('kick');
        if (!v.allowed || !targetMember) {
          botMessages.push(addBotReply(chatId, v.reason || 'Cannot kick target.', userMessage.id, trimmedText));
          break;
        }
        botDb.setMemberActive(chatId, targetMember.user_id, false);
        botMessages.push(addBotReply(chatId, `Kicked ${targetMember.full_name}.`, userMessage.id, trimmedText));
        break;
      }
      case 'mute':
      case 'tmute': {
        if (!senderIsAdmin) {
          botMessages.push(addBotReply(chatId, `You must be a group admin to use /${cmd}.`, userMessage.id, trimmedText));
          break;
        }
        const v = checkSimTarget('mute');
        if (!v.allowed || !targetMember) {
          botMessages.push(addBotReply(chatId, v.reason || 'Cannot mute target.', userMessage.id, trimmedText));
          break;
        }
        const mins = extractMuteMinutes(targetRes.remainingArgs, targetRes.resolvedFromReply, targetMember.user_id);
        if (cmd === 'tmute' && !mins) {
          botMessages.push(
            addBotReply(
              chatId,
              'Usage: /tmute @user <time> (e.g. 30m, 2h, 1d). Use /mute for a permanent mute.',
              userMessage.id,
              trimmedText
            )
          );
          break;
        }
        const until = mins ? new Date(Date.now() + mins * 60000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : null;
        botDb.setMemberMuted(chatId, targetMember.user_id, true, until);
        botMessages.push(
          addBotReply(
            chatId,
            `Muted ${targetMember.full_name}${mins ? ` for ${mins} min` : ''}.`,
            userMessage.id,
            trimmedText
          )
        );
        break;
      }
      case 'unmute': {
        if (!senderIsAdmin) {
          botMessages.push(addBotReply(chatId, 'You must be a group admin to use /unmute.', userMessage.id, trimmedText));
          break;
        }
        const v = checkSimTarget('unmute');
        if (!v.allowed || !targetMember) {
          botMessages.push(addBotReply(chatId, v.reason || 'Cannot unmute target.', userMessage.id, trimmedText));
          break;
        }
        botDb.setMemberMuted(chatId, targetMember.user_id, false, null);
        botMessages.push(addBotReply(chatId, `Unmuted ${targetMember.full_name}.`, userMessage.id, trimmedText));
        break;
      }
      case 'promote': {
        if (!senderIsAdmin) {
          botMessages.push(addBotReply(chatId, 'You must be a group admin to use /promote.', userMessage.id, trimmedText));
          break;
        }
        const v = checkSimTarget('promote');
        if (!v.allowed || !targetMember) {
          botMessages.push(addBotReply(chatId, v.reason || 'Cannot promote target.', userMessage.id, trimmedText));
          break;
        }
        const customTitle = targetRes.remainingArgs.join(' ').trim().slice(0, 16);
        botDb.setMemberRole(chatId, targetMember.user_id, 'administrator');
        botMessages.push(
          addBotReply(
            chatId,
            `Promoted ${targetMember.full_name} to Administrator${customTitle ? ` (Title: ${customTitle})` : ''}.`,
            userMessage.id,
            trimmedText
          )
        );
        break;
      }
      case 'demote': {
        if (!senderIsAdmin) {
          botMessages.push(addBotReply(chatId, 'You must be a group admin to use /demote.', userMessage.id, trimmedText));
          break;
        }
        const v = checkSimTarget('demote');
        if (!v.allowed || !targetMember) {
          botMessages.push(addBotReply(chatId, v.reason || 'Cannot demote target.', userMessage.id, trimmedText));
          break;
        }
        botDb.setMemberRole(chatId, targetMember.user_id, 'member');
        botMessages.push(addBotReply(chatId, `Demoted ${targetMember.full_name} to regular member.`, userMessage.id, trimmedText));
        break;
      }
      case 'del': {
        if (!senderIsAdmin) {
          botMessages.push(addBotReply(chatId, 'You must be a group admin to use /del.', userMessage.id, trimmedText));
          break;
        }
        if (!replyTargetMsg) {
          botMessages.push(addBotReply(chatId, 'Reply to a message to delete it.', userMessage.id, trimmedText));
          break;
        }
        botMessages.push(addBotReply(chatId, `Deleted message #${replyTargetMsg.id} from ${replyTargetMsg.sender_name}.`, userMessage.id, trimmedText));
        break;
      }
      case 'warn': {
        if (!senderIsAdmin) {
          botMessages.push(addBotReply(chatId, 'You must be a group admin to use /warn.', userMessage.id, trimmedText));
          break;
        }
        const v = checkSimTarget('warn');
        if (!v.allowed || !targetMember) {
          botMessages.push(addBotReply(chatId, v.reason || 'Cannot warn target.', userMessage.id, trimmedText));
          break;
        }
        const warns = botDb.addWarn(chatId, targetMember.user_id);
        if (warns >= settings.max_warns) {
          botDb.resetWarns(chatId, targetMember.user_id);
          botDb.setMemberActive(chatId, targetMember.user_id, false);
          botMessages.push(
            addBotReply(
              chatId,
              `${targetMember.full_name} reached ${warns}/${settings.max_warns} warnings and has been banned.`,
              userMessage.id,
              trimmedText
            )
          );
        } else {
          botMessages.push(
            addBotReply(
              chatId,
              `${targetMember.full_name} has been warned (${warns}/${settings.max_warns}).`,
              userMessage.id,
              trimmedText
            )
          );
        }
        break;
      }
      case 'warns': {
        if (unresolvedMentionMsg && !targetMember) {
          botMessages.push(addBotReply(chatId, unresolvedMentionMsg, userMessage.id, trimmedText));
          break;
        }
        const who = targetMember ?? updatedSender;
        botMessages.push(
          addBotReply(
            chatId,
            `${who.full_name} has ${who.warns}/${settings.max_warns} warnings.`,
            userMessage.id,
            trimmedText
          )
        );
        break;
      }
      case 'resetwarns': {
        if (!senderIsAdmin) {
          botMessages.push(addBotReply(chatId, 'You must be a group admin to use /resetwarns.', userMessage.id, trimmedText));
          break;
        }
        if (!targetMember) {
          botMessages.push(
            addBotReply(
              chatId,
              unresolvedMentionMsg || 'Reply to a user or provide ID/@username to reset warnings.',
              userMessage.id,
              trimmedText
            )
          );
          break;
        }
        botDb.resetWarns(chatId, targetMember.user_id);
        botMessages.push(addBotReply(chatId, `Warnings reset for ${targetMember.full_name}.`, userMessage.id, trimmedText));
        break;
      }
      case 'pin': {
        if (!senderIsAdmin) {
          botMessages.push(addBotReply(chatId, 'You must be a group admin to use /pin.', userMessage.id, trimmedText));
          break;
        }
        if (!replyTargetMsg) {
          botMessages.push(addBotReply(chatId, 'Reply to a message to pin it.', userMessage.id, trimmedText));
          break;
        }
        botDb.updateGroupSettings(chatId, { pinned_message_id: replyTargetMsg.id });
        botMessages.push(addBotReply(chatId, `Pinned message #${replyTargetMsg.id}.`, userMessage.id, trimmedText));
        break;
      }
      case 'unpin': {
        if (!senderIsAdmin) {
          botMessages.push(addBotReply(chatId, 'You must be a group admin to use /unpin.', userMessage.id, trimmedText));
          break;
        }
        botDb.updateGroupSettings(chatId, { pinned_message_id: null });
        botMessages.push(addBotReply(chatId, 'Unpinned group message successfully.', userMessage.id, trimmedText));
        break;
      }
      case 'setwelcome': {
        if (!senderIsAdmin) {
          botMessages.push(addBotReply(chatId, 'Only admins can set the welcome message.', userMessage.id, trimmedText));
          break;
        }
        if (!parsed.rawArgs) {
          botMessages.push(
            addBotReply(
              chatId,
              'Usage: /setwelcome Hello {name}! How are you doing? Welcome to {chat_title}!',
              userMessage.id,
              trimmedText
            )
          );
          break;
        }
        botDb.updateGroupSettings(chatId, { welcome_text: parsed.rawArgs });
        botMessages.push(addBotReply(chatId, 'Welcome message updated.', userMessage.id, trimmedText));
        break;
      }
      case 'welcome': {
        if (!senderIsAdmin) {
          botMessages.push(addBotReply(chatId, 'Only admins can toggle welcome messages.', userMessage.id, trimmedText));
          break;
        }
        const arg = parsed.args[0]?.toLowerCase();
        if (arg !== 'on' && arg !== 'off') {
          botMessages.push(addBotReply(chatId, 'Usage: /welcome on or /welcome off', userMessage.id, trimmedText));
          break;
        }
        const enabled = arg === 'on';
        botDb.updateGroupSettings(chatId, { welcome_enabled: enabled });
        botMessages.push(
          addBotReply(chatId, `Welcome messages turned ${enabled ? 'ON' : 'OFF'}.`, userMessage.id, trimmedText)
        );
        break;
      }
      case 'setrules': {
        if (!senderIsAdmin) {
          botMessages.push(addBotReply(chatId, 'Only admins can set rules.', userMessage.id, trimmedText));
          break;
        }
        if (!parsed.rawArgs) {
          botMessages.push(addBotReply(chatId, 'Usage: /setrules No spam, stay focused on CA prep!', userMessage.id, trimmedText));
          break;
        }
        botDb.updateGroupSettings(chatId, { rules_text: parsed.rawArgs });
        botMessages.push(addBotReply(chatId, 'Group rules updated.', userMessage.id, trimmedText));
        break;
      }
      case 'rules': {
        botMessages.push(
          addBotReply(chatId, `Group Rules:\n${settings.rules_text}`, userMessage.id, trimmedText)
        );
        break;
      }
      default: {
        botMessages.push(
          addBotReply(chatId, `Unknown command /${cmd}. Send /help to see supported commands.`, userMessage.id, trimmedText)
        );
      }
    }

    return { userMessage, botMessages };
  }

  // Non-command message: trigger Gemini CA Study Guider only when explicitly @mentioned or replying to a CA AI answer
  const isReplyToCaBot = Boolean(
    replyTargetMsg &&
      replyTargetMsg.sender_id === BOT_USER_ID &&
      replyTargetMsg.message_type === 'ca_ai'
  );
  const triggered = isBotMentionedOrReplied(trimmedText, BOT_USERNAME_DEFAULT, isReplyToCaBot, false);

  if (triggered) {
    let cleaned = stripBotMention(trimmedText, BOT_USERNAME_DEFAULT);
    if (replyTargetMsg && replyTargetMsg.sender_id !== BOT_USER_ID && replyTargetMsg.text) {
      cleaned = `Referenced message: ${replyTargetMsg.text}\n\nUser request: ${cleaned}`.trim();
    }

    const hasAudio = Boolean(params.audioBase64);
    if (!hasAudio && isCasualAckOrGreeting(cleaned)) {
      return { userMessage, botMessages };
    }

    if (!cleaned && !hasAudio) {
      if (!botDb.hasCaNoticeSent(chatId, updatedSender.user_id)) {
        botDb.markCaNoticeSent(chatId, updatedSender.user_id);
        botMessages.push(
          addBotReply(
            chatId,
            `${CA_ONE_TIME_NOTICE} Example: @${BOT_USERNAME_DEFAULT} Explain Section 44AD presumptive taxation.`,
            userMessage.id,
            trimmedText,
            'bot_reply'
          )
        );
      }
    } else {
      try {
        const answer = await askGeminiCA({
          promptText: cleaned,
          audioBase64: params.audioBase64,
          audioMime: params.audioMime,
        });
        if (isNonCaSentinelOrRefusal(answer)) {
          if (!botDb.hasCaNoticeSent(chatId, updatedSender.user_id)) {
            botDb.markCaNoticeSent(chatId, updatedSender.user_id);
            botMessages.push(
              addBotReply(chatId, CA_ONE_TIME_NOTICE, userMessage.id, trimmedText, 'bot_reply')
            );
          }
        } else {
          botMessages.push(addBotReply(chatId, answer, userMessage.id, trimmedText, 'ca_ai'));
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Gemini AI request failed.';
        botMessages.push(
          addBotReply(chatId, `CA Guider error: ${errMsg}`, userMessage.id, trimmedText, 'bot_reply')
        );
      }
    }
  }

  return { userMessage, botMessages };
}

export function simulateMemberJoin(params: {
  chatId?: number;
  fullName: string;
  username?: string;
}): { member: GroupMember; welcomeMessage: ChatMessage | null } {
  const chatId = params.chatId ?? DEFAULT_CHAT_ID;
  const uid = Math.floor(2000000 + Math.random() * 7000000);
  const cleanHandle = (params.username || params.fullName.toLowerCase().replace(/[^a-z0-9]+/g, '_')).replace(/^@/, '');

  const member = botDb.upsertMember({
    chatId,
    userId: uid,
    username: cleanHandle,
    fullName: params.fullName.trim(),
    role: 'member',
    isBot: false,
    isActive: true,
    incrementMsg: false,
  });

  const settings = botDb.getGroupSettings(chatId);
  let welcomeMessage: ChatMessage | null = null;

  if (settings.welcome_enabled) {
    const rendered = renderWelcomeMessage(settings.welcome_text, member, settings.chat_title, 'plain');
    welcomeMessage = addBotReply(chatId, rendered, null, null, 'system');
  }

  return { member, welcomeMessage };
}

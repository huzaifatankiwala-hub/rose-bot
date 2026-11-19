import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { BOT_USER_ID, BOT_USERNAME_DEFAULT } from './src/lib/botLogic';
import { botDb, DEFAULT_CHAT_ID } from './src/server/db';
import {
  askGeminiCA,
  fetchWeatherForCity,
  processSimulatorMessage,
  simulateMemberJoin,
} from './src/server/services';
import { TelegramBridge } from './src/server/telegramBridge';
import { ownerMtproto } from './src/server/ownerMtproto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

const telegramBridge = new TelegramBridge(TELEGRAM_BOT_TOKEN);
if (TELEGRAM_BOT_TOKEN.trim()) {
  void telegramBridge.start();
}
void ownerMtproto.initFromSavedConfig();

process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled promise rejection (kept alive):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught exception (kept alive):', err);
});

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, mode: telegramBridge.getStatus().mode });
  });

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, mode: telegramBridge.getStatus().mode });
  });

  app.get('/api/telegram/webhook/probe', (_req, res) => {
    res.json({ ok: true, service: 'ca-rose-bot' });
  });

  app.post('/api/telegram/webhook', (req, res) => {
    const headerSecret = req.header('x-telegram-bot-api-secret-token');
    if (!telegramBridge.verifyWebhookSecret(headerSecret)) {
      res.status(401).json({ ok: false, error: 'Invalid Telegram webhook secret.' });
      return;
    }
    res.status(200).json({ ok: true });
    void telegramBridge.handleWebhookUpdate(req.body).catch((err) => {
      console.error('[TelegramWebhook] Error handling update:', err);
    });
  });

  app.post('/api/telegram/hosting', async (req, res) => {
    try {
      const { action, webhookUrl } = req.body as {
        action?: 'enable-webhook' | 'enable-polling';
        webhookUrl?: string;
      };
      if (action === 'enable-webhook') {
        const status = await telegramBridge.enableWebhook(String(webhookUrl || ''));
        res.json({ ok: true, telegram: status });
        return;
      }
      if (action === 'enable-polling') {
        const status = await telegramBridge.disableWebhookAndPoll();
        res.json({ ok: true, telegram: status });
        return;
      }
      res.status(400).json({ error: 'Unsupported hosting action.' });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update hosting mode.' });
    }
  });

  app.get('/api/state', (_req, res) => {
    try {
      const settings = botDb.getGroupSettings(DEFAULT_CHAT_ID);
      const members = botDb.getMembers(DEFAULT_CHAT_ID);
      const messages = botDb.getMessages(DEFAULT_CHAT_ID, 100);
      const pinnedMessage = settings.pinned_message_id
        ? botDb.getMessageById(settings.pinned_message_id)
        : null;

      res.json({
        settings,
        members,
        messages,
        pinnedMessage,
        telegram: telegramBridge.getStatus(),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load state' });
    }
  });

  app.post('/api/chat/command', async (req, res) => {
    try {
      const { senderId, text, replyToId, audioBase64, audioMime, audioName } = req.body as {
        senderId?: number;
        text?: string;
        replyToId?: number | null;
        audioBase64?: string;
        audioMime?: string;
        audioName?: string;
      };

      if (!senderId) {
        res.status(400).json({ error: 'senderId is required.' });
        return;
      }
      if ((!text || !text.trim()) && !audioBase64) {
        res.status(400).json({ error: 'Please enter a message, command, or attach an audio clip.' });
        return;
      }

      const result = await processSimulatorMessage({
        chatId: DEFAULT_CHAT_ID,
        senderId: Number(senderId),
        text: text || '',
        replyToId: replyToId ?? null,
        audioBase64,
        audioMime,
        audioName,
      });

      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Command execution failed.';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/ca-guide', async (req, res) => {
    try {
      const { prompt, audioBase64, audioMime } = req.body as {
        prompt?: string;
        audioBase64?: string;
        audioMime?: string;
      };

      if ((!prompt || !prompt.trim()) && !audioBase64) {
        res.status(400).json({ error: 'Please provide a CA question or audio note.' });
        return;
      }

      const answer = await askGeminiCA({
        promptText: prompt || '',
        audioBase64,
        audioMime,
      });

      res.json({ answer });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gemini CA Guider failed.';
      res.status(500).json({ error: message });
    }
  });

  app.get('/api/weather', async (req, res) => {
    try {
      const city = String(req.query.city || '').trim();
      if (!city) {
        res.status(400).json({ error: 'city query parameter is required.' });
        return;
      }
      const weather = await fetchWeatherForCity(city);
      res.json(weather);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Weather lookup failed.';
      res.status(404).json({ error: message });
    }
  });

  app.post('/api/members/join', (req, res) => {
    try {
      const { fullName, username } = req.body as { fullName?: string; username?: string };
      if (!fullName || !fullName.trim()) {
        res.status(400).json({ error: 'Member full name is required.' });
        return;
      }
      const result = simulateMemberJoin({
        chatId: DEFAULT_CHAT_ID,
        fullName: fullName.trim(),
        username: username?.trim(),
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to add member' });
    }
  });

  app.post('/api/members/:userId/action', (req, res) => {
    try {
      const targetId = Number(req.params.userId);
      const { actorId, action, muteMinutes } = req.body as {
        actorId?: number;
        action?: 'warn' | 'resetwarns' | 'mute' | 'unmute' | 'ban' | 'unban' | 'kick' | 'promote' | 'demote';
        muteMinutes?: number;
      };

      const actor = actorId ? botDb.getMember(DEFAULT_CHAT_ID, Number(actorId)) : null;
      if (!actor || (actor.role !== 'owner' && actor.role !== 'administrator')) {
        res.status(403).json({ error: 'Only group admins can perform moderation actions.' });
        return;
      }

      const target = botDb.getMember(DEFAULT_CHAT_ID, targetId);
      if (!target) {
        res.status(404).json({ error: 'Member not found.' });
        return;
      }
      if (target.user_id === BOT_USER_ID || target.role === 'owner') {
        res.status(400).json({ error: 'Cannot apply moderation action to the bot or group owner.' });
        return;
      }

      const settings = botDb.getGroupSettings(DEFAULT_CHAT_ID);
      let logText = '';

      switch (action) {
        case 'warn': {
          const warns = botDb.addWarn(DEFAULT_CHAT_ID, targetId);
          if (warns >= settings.max_warns) {
            botDb.resetWarns(DEFAULT_CHAT_ID, targetId);
            botDb.setMemberActive(DEFAULT_CHAT_ID, targetId, false);
            logText = `${target.full_name} reached ${warns}/${settings.max_warns} warnings and was banned by ${actor.full_name}.`;
          } else {
            logText = `${target.full_name} received a warning (${warns}/${settings.max_warns}) from ${actor.full_name}.`;
          }
          break;
        }
        case 'resetwarns':
          botDb.resetWarns(DEFAULT_CHAT_ID, targetId);
          logText = `Warnings reset to 0 for ${target.full_name}.`;
          break;
        case 'mute': {
          const mins = muteMinutes && muteMinutes > 0 ? muteMinutes : 30;
          const until = new Date(Date.now() + mins * 60000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
          botDb.setMemberMuted(DEFAULT_CHAT_ID, targetId, true, until);
          logText = `${target.full_name} muted for ${mins} min.`;
          break;
        }
        case 'unmute':
          botDb.setMemberMuted(DEFAULT_CHAT_ID, targetId, false, null);
          logText = `${target.full_name} unmuted.`;
          break;
        case 'ban':
          botDb.setMemberActive(DEFAULT_CHAT_ID, targetId, false);
          logText = `${target.full_name} banned from the group.`;
          break;
        case 'unban':
          botDb.setMemberActive(DEFAULT_CHAT_ID, targetId, true);
          logText = `${target.full_name} unbanned and restored to active roster.`;
          break;
        case 'kick':
          botDb.setMemberActive(DEFAULT_CHAT_ID, targetId, false);
          logText = `${target.full_name} kicked from the group.`;
          break;
        case 'promote':
          botDb.setMemberRole(DEFAULT_CHAT_ID, targetId, 'administrator');
          logText = `${target.full_name} promoted to Administrator.`;
          break;
        case 'demote':
          botDb.setMemberRole(DEFAULT_CHAT_ID, targetId, 'member');
          logText = `${target.full_name} changed to Member.`;
          break;
        default:
          res.status(400).json({ error: 'Unsupported moderation action.' });
          return;
      }

      botDb.addMessage({
        chatId: DEFAULT_CHAT_ID,
        senderId: BOT_USER_ID,
        senderName: 'CA Rose Guider',
        senderUsername: BOT_USERNAME_DEFAULT,
        senderRole: 'administrator',
        isBot: true,
        text: logText,
        messageType: 'system',
      });

      res.json({ ok: true, message: logText, member: botDb.getMember(DEFAULT_CHAT_ID, targetId) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Moderation failed.' });
    }
  });

  app.patch('/api/settings', (req, res) => {
    try {
      const { chat_title, welcome_enabled, welcome_text, rules_text, max_warns } = req.body as {
        chat_title?: string;
        welcome_enabled?: boolean;
        welcome_text?: string;
        rules_text?: string;
        max_warns?: number;
      };

      const updated = botDb.updateGroupSettings(DEFAULT_CHAT_ID, {
        ...(chat_title !== undefined ? { chat_title: chat_title.trim() } : {}),
        ...(welcome_enabled !== undefined ? { welcome_enabled } : {}),
        ...(welcome_text !== undefined ? { welcome_text } : {}),
        ...(rules_text !== undefined ? { rules_text } : {}),
        ...(max_warns !== undefined ? { max_warns: Math.max(1, Math.min(10, Number(max_warns))) } : {}),
      });

      res.json({ settings: updated });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update settings' });
    }
  });

  app.get('/api/owner-override/status', (_req, res) => {
    res.json({ ownerOverride: ownerMtproto.getStatus() });
  });

  app.post('/api/owner-override/send-code', async (req, res) => {
    try {
      const { apiId, apiHash, phoneNumber } = req.body as {
        apiId?: number | string;
        apiHash?: string;
        phoneNumber?: string;
      };
      const result = await ownerMtproto.startCodeLogin({
        apiId: Number(apiId),
        apiHash: String(apiHash || ''),
        phoneNumber: String(phoneNumber || ''),
      });
      res.json({ ...result, status: ownerMtproto.getStatus() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to send Telegram code.' });
    }
  });

  app.post('/api/owner-override/verify-code', async (req, res) => {
    try {
      const { phoneCode, password } = req.body as {
        phoneCode?: string;
        password?: string;
      };
      const result = await ownerMtproto.completeCodeLogin({ phoneCode, password });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Verification failed.' });
    }
  });

  app.post('/api/owner-override/connect-session', async (req, res) => {
    try {
      const { apiId, apiHash, sessionString } = req.body as {
        apiId?: number | string;
        apiHash?: string;
        sessionString?: string;
      };
      const result = await ownerMtproto.connectWithSessionString({
        apiId: Number(apiId),
        apiHash: String(apiHash || ''),
        sessionString: String(sessionString || ''),
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to connect session string.' });
    }
  });

  app.post('/api/owner-override/disconnect', async (_req, res) => {
    try {
      const status = await ownerMtproto.disconnect();
      res.json({ ok: true, status });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to disconnect Owner Override.' });
    }
  });

  app.post('/api/reset', (_req, res) => {
    try {
      botDb.resetDefaultGroup();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Reset failed' });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`CA Rose Bot Studio running on http://localhost:${PORT}`);
  });
}

void startServer();

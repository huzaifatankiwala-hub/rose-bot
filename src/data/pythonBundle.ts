export interface PythonSourceFile {
  id:
    | 'bot.py'
    | 'database.py'
    | 'requirements.txt'
    | '.env.example'
    | 'Dockerfile'
    | 'render.yaml'
    | 'Procfile';
  filename: string;
  language: 'python' | 'text' | 'dotenv' | 'dockerfile' | 'yaml';
  description: string;
  content: string;
}

export const PYTHON_SOURCE_FILES: PythonSourceFile[] = [
  {
    id: 'bot.py',
    filename: 'bot.py',
    language: 'python',
    description:
      'Main python-telegram-bot v21+ entrypoint with Rose-style moderation (/promote, /demote, /ban, /kick, /mute), chunked /tagall with permission debug, Open-Meteo /weather, admin /info, and Gemini CA Study Guider.',
    content: `import asyncio
import html
import logging
import os
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Optional, Tuple

import httpx
from dotenv import load_dotenv
from google import genai
from google.genai import types
from telegram import ChatMember, ChatMemberAdministrator, ChatPermissions, Message, Update
from telegram.constants import ChatAction, ChatMemberStatus, ChatType, ParseMode
from telegram.error import RetryAfter, TelegramError
from telegram.ext import (
    Application,
    ChatMemberHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    MessageReactionHandler,
    filters,
)

from database import Database

# -------------------- Configuration --------------------
load_dotenv()

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-4-hydrogen").strip()
GEMINI_FALLBACK_MODEL = os.getenv("GEMINI_FALLBACK_MODEL", "gemini-3.1-flash-lite").strip()
DB_PATH = os.getenv("DB_PATH", "bot_data.db").strip()

# Optional: Owner MTProto credentials to demote/promote ANY old admin (even those promoted by Owner)
TELEGRAM_API_ID = os.getenv("TELEGRAM_API_ID", "").strip()
TELEGRAM_API_HASH = os.getenv("TELEGRAM_API_HASH", "").strip()
OWNER_SESSION_STRING = os.getenv("OWNER_SESSION_STRING", "").strip()

try:
    from telethon import TelegramClient
    from telethon.sessions import StringSession
    from telethon.tl.functions.channels import EditAdminRequest
    from telethon.tl.types import ChannelParticipantsAdmins, ChatAdminRights
except ImportError:
    TelegramClient = None  # Optional unless OWNER_SESSION_STRING is configured

if not TELEGRAM_BOT_TOKEN:
    raise RuntimeError("TELEGRAM_BOT_TOKEN is missing in .env")
if not GEMINI_API_KEY:
    raise RuntimeError("GEMINI_API_KEY is missing in .env")

logging.basicConfig(
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger("CA_Rose_Bot")

db = Database(DB_PATH)
gemini_client = genai.Client(api_key=GEMINI_API_KEY)

MAX_TG_LEN = 4096
TAGALL_CHUNK_SIZE = 100
TAGALL_MAX_CHARS = 3800
TAGALL_MAX_RAW_HTML = 12000
MAX_AUDIO_BYTES = 20 * 1024 * 1024
NON_CA_SENTINEL = "[NON_CA_QUERY]"
CA_ONE_TIME_NOTICE = (
    "I specialize strictly in Chartered Accountancy (CA / ICAI) studies & exams. "
    "Tag me whenever you have a CA doubt or voice/audio answer to evaluate!"
)

CASUAL_ACK_PATTERN = re.compile(
    r"^(ok+|okay|kk?|thanks?|thank\\s*you|thx|tq|ty|hm+|hmm+|yes|no|yeah|yep|nope|yup|"
    r"haha+|lol|lmao|nice|great|cool|good|gm|gn|good\\s*(?:morning|night|evening)|"
    r"hi+|hello+|hey+|bye+|done|got\\s*it|noted|sure|alright|haan|ji|accha|achha|theek|thik|"
    r"dhanyawad|shukriya|bhai|bro|sir|maam|mam)[!.,?\\s]*$",
    re.IGNORECASE,
)

CA_SYSTEM_INSTRUCTION = """
You are an expert Chartered Accountancy (CA) Exam Mentor & Study Guider specializing STRICTLY in CA studies (ICAI syllabus: CA Foundation, CA Intermediate, CA Final, and Articleship/practical training).

STRICT DOMAIN RULES:
1. You ONLY answer questions related to Chartered Accountancy (CA) exams, CA syllabus subjects (Accounting, Ind AS, Corporate & Other Laws, Direct & Indirect Taxation / GST, Cost & Management Accounting, Auditing & Ethics, Financial Management, Strategic Management, AFM, IBS), CA exam preparation strategies, ICAI study material, RTPs/MTPs/Past Papers, revision plans, memory techniques, and exam writing tips.
2. If the user sends a voice/audio message, listen carefully to what they said (question, doubt, spoken answer for evaluation, or study request).
   - If it is a CA question or spoken CA answer/concept explanation, evaluate or answer it accurately with section numbers, Accounting Standards / Ind AS / SAs references where relevant, and exam presentation tips.
   - If the audio or text is NOT related to CA studies/exams (e.g., general coding, movies, gossip, casual chat, non-CA subjects), respond with EXACTLY the single token: [NON_CA_QUERY] and nothing else.
3. Keep formatting clean and easy to read in Telegram (use short headings, bullet points, and clear steps; avoid massive raw markdown tables).
4. Note clearly whenever a tax provision depends on the Finance Act / Assessment Year, and guide them accordingly.
""".strip()

MUTE_PERMISSIONS = ChatPermissions(
    can_send_messages=False,
    can_send_audios=False,
    can_send_documents=False,
    can_send_photos=False,
    can_send_videos=False,
    can_send_video_notes=False,
    can_send_voice_notes=False,
    can_send_polls=False,
    can_send_other_messages=False,
    can_add_web_page_previews=False,
)

UNMUTE_PERMISSIONS = ChatPermissions(
    can_send_messages=True,
    can_send_audios=True,
    can_send_documents=True,
    can_send_photos=True,
    can_send_videos=True,
    can_send_video_notes=True,
    can_send_voice_notes=True,
    can_send_polls=True,
    can_send_other_messages=True,
    can_add_web_page_previews=True,
)

PERMISSION_LABELS = {
    "can_delete_messages": "Delete Messages",
    "can_restrict_members": "Ban Users (Restrict Members)",
    "can_pin_messages": "Pin Messages",
    "can_promote_members": "Add New Admins (Promote/Demote)",
}

WMO_CODES = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Depositing rime fog",
    51: "Light drizzle",
    53: "Moderate drizzle",
    55: "Dense drizzle",
    61: "Slight rain",
    63: "Moderate rain",
    65: "Heavy rain",
    71: "Slight snowfall",
    73: "Moderate snowfall",
    75: "Heavy snowfall",
    80: "Slight rain showers",
    81: "Moderate rain showers",
    82: "Violent rain showers",
    95: "Thunderstorm",
    96: "Thunderstorm with slight hail",
    99: "Thunderstorm with heavy hail",
}


def mention_html(user_id: int, name: str) -> str:
    safe_name = html.escape(name or "User")
    return f'<a href="tg://user?id={user_id}">{safe_name}</a>'


def is_group_chat(update: Update) -> bool:
    chat = update.effective_chat
    return bool(chat and chat.type in (ChatType.GROUP, ChatType.SUPERGROUP))


async def get_chat_member_safe(
    context: ContextTypes.DEFAULT_TYPE, chat_id: int, user_id: int
) -> Optional[ChatMember]:
    try:
        return await context.bot.get_chat_member(chat_id, user_id)
    except TelegramError:
        return None


async def is_user_admin(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    user_id: Optional[int] = None,
    required_right: Optional[str] = None,
) -> bool:
    chat = update.effective_chat
    msg = update.effective_message
    if not chat:
        return False
    if chat.type == ChatType.PRIVATE:
        return True
    if msg and msg.sender_chat and msg.sender_chat.id == chat.id and user_id is None:
        return True

    target_uid = user_id if user_id is not None else (update.effective_user.id if update.effective_user else None)
    if target_uid is None:
        return False
    if target_uid == 1087968824:
        return True

    member = await get_chat_member_safe(context, chat.id, target_uid)
    if not member:
        return False
    if member.status == ChatMemberStatus.OWNER:
        return True
    if member.status != ChatMemberStatus.ADMINISTRATOR:
        return False
    if required_right:
        return bool(getattr(member, required_right, False))
    return True


SYSTEM_TG_ACCOUNT_IDS = {1087968824, 777000, 136817688}


async def check_bot_permissions(
    context: ContextTypes.DEFAULT_TYPE,
    chat_id: int,
    required_rights: list[str],
    command_name: str,
) -> Tuple[bool, Optional[ChatMember], str]:
    bot_member = await get_chat_member_safe(context, chat_id, context.bot.id)
    status = bot_member.status.value if bot_member else "unknown"
    is_owner = bool(bot_member and bot_member.status == ChatMemberStatus.OWNER)
    is_admin = bool(bot_member and bot_member.status in (ChatMemberStatus.ADMINISTRATOR, ChatMemberStatus.OWNER))

    missing: list[str] = []
    if not is_admin:
        missing.append("Administrator Role")

    lines = [
        f"<b>Permission Debug for /{html.escape(command_name)}</b>",
        f"• <b>Bot Group Status:</b> {html.escape(status.upper())}{'' if is_admin else ' (Not Admin)'}",
        "• <b>Required Permissions:</b>",
    ]

    for key in required_rights:
        label = PERMISSION_LABELS.get(key, key)
        granted = is_owner or (is_admin and bool(getattr(bot_member, key, False)))
        if not granted:
            missing.append(label)
        lines.append(f"  {'✅' if granted else '❌'} {html.escape(label)}")

    ok = is_admin and len(missing) == 0
    if not ok:
        lines.append(
            f"\\n<i>Fix: Open Group Settings → Administrators → select this bot and enable: "
            f"<b>{html.escape(', '.join(dict.fromkeys(missing)))}</b>.</i>"
        )

    return ok, bot_member, "\\n".join(lines)


def evaluate_promote_bot_rights(bot_member: Optional[ChatMember]) -> Tuple[bool, dict[str, bool], str]:
    is_owner = bool(bot_member and bot_member.status == ChatMemberStatus.OWNER)
    is_adm_obj = isinstance(bot_member, ChatMemberAdministrator)
    rights = {
        "can_manage_chat": is_owner or (is_adm_obj and bool(bot_member.can_manage_chat)),
        "can_delete_messages": is_owner or (is_adm_obj and bool(bot_member.can_delete_messages)),
        "can_manage_video_chats": is_owner or (is_adm_obj and bool(bot_member.can_manage_video_chats)),
        "can_restrict_members": is_owner or (is_adm_obj and bool(bot_member.can_restrict_members)),
        "can_invite_users": is_owner or (is_adm_obj and bool(bot_member.can_invite_users)),
        "can_pin_messages": is_owner or (is_adm_obj and bool(bot_member.can_pin_messages)),
    }
    if not any(rights.values()):
        return (
            False,
            rights,
            "I only have <b>Add New Admins</b> enabled with zero other admin permissions to grant. "
            "Telegram treats promoting with all permissions disabled as a demotion/no-op.\\n\\n"
            "<i>Fix: Group Settings → Administrators → enable at least one right (e.g. Delete Messages, Ban Users, or Pin Messages) for this bot.</i>",
        )
    return True, rights, ""


def parse_duration_minutes(token: str) -> Optional[int]:
    clean = re.sub(r"[.,:;!?]+$", "", token.strip().lower())
    m = re.match(r"^(\\d+)(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks)?$", clean)
    if not m:
        return None
    val = int(m.group(1))
    unit_raw = m.group(2) or "m"
    unit = "h" if unit_raw.startswith("h") else "d" if unit_raw.startswith("d") else "w" if unit_raw.startswith("w") else "m"
    mult = {"m": 1, "h": 60, "d": 1440, "w": 10080}[unit]
    total = val * mult
    if total <= 0 or total > 525600:
        return None
    return total


def extract_duration_minutes(args: list[str], resolved_from_reply: bool, target_uid: int) -> Optional[int]:
    for arg in args or []:
        clean = arg.strip()
        if not resolved_from_reply and clean.isdigit() and int(clean) == target_uid:
            continue
        mins = parse_duration_minutes(clean)
        if mins is not None:
            return mins
    return None


def _get_real_reply_message(msg: Optional[Message]) -> Optional[Message]:
    if not msg or not msg.reply_to_message:
        return None
    r_msg = msg.reply_to_message
    if getattr(r_msg, "forum_topic_created", None) is not None:
        return None
    if msg.message_thread_id and r_msg.message_id == msg.message_thread_id:
        return None
    return r_msg


def _format_telegram_mod_error(action_verb: str, target_html: Optional[str], err: Exception, cmd_name: Optional[str] = None) -> str:
    err_str = str(err)
    upper = err_str.upper()
    cmd = cmd_name or action_verb
    prefix = f" {target_html}" if target_html else ""
    if "USER_ADMIN_INVALID" in upper or "OWNER" in upper:
        return f"Cannot {html.escape(action_verb)}{prefix}: Telegram does not allow restricting or banning group admins/owner. Demote them first with /demote."
    if "NOT ENOUGH RIGHTS" in upper or "CHAT_ADMIN_REQUIRED" in upper or "RIGHT_FORBIDDEN" in upper:
        if action_verb == "delete" or cmd == "del":
            return "Bot lacks <b>Delete Messages</b> permission in Group Settings → Administrators."
        if action_verb in ("pin", "unpin"):
            return "Bot lacks <b>Pin Messages</b> permission in Group Settings → Administrators."
        return f"Bot lacks required admin permissions in Group Settings → Administrators for <code>/{html.escape(cmd)}</code>."
    if "SUPERGROUP" in upper:
        return f"<code>/{html.escape(cmd)}</code> requires the group to be upgraded to a Telegram Supergroup."
    if "USER_NOT_PARTICIPANT" in upper:
        return f"Cannot {html.escape(action_verb)}{prefix}: user is not currently in this group."
    if "MESSAGE CAN'T BE DELETED" in upper or "MESSAGE TO DELETE NOT FOUND" in upper:
        return "Could not delete message: Telegram only allows deleting messages less than 48 hours old (or it was already deleted)."
    if "MESSAGE TO PIN NOT FOUND" in upper or "MESSAGE_ID_INVALID" in upper:
        return "Target message could not be found in this chat."
    if "CHAT_NOT_MODIFIED" in upper:
        return f"{target_html} is already in that state." if target_html else "No changes needed — chat state is already updated."
    return f"Failed to {html.escape(action_verb)}{prefix}: <code>{html.escape(err_str)}</code>"


async def resolve_target_context(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> dict:
    msg = update.effective_message
    chat = update.effective_chat
    args = list(context.args or [])
    result = {
        "uid": None,
        "name": None,
        "username": None,
        "member_cm": None,
        "resolved_from_reply": False,
        "remaining_args": args,
        "error": None,
    }
    if not msg or not chat:
        return result

    real_reply = _get_real_reply_message(msg)
    if real_reply:
        r_msg = real_reply
        if r_msg.sender_chat and (not r_msg.from_user or r_msg.from_user.id in SYSTEM_TG_ACCOUNT_IDS):
            result["error"] = "Cannot target anonymous admin or linked channel posts."
            return result
        if r_msg.from_user:
            u = r_msg.from_user
            if u.id in SYSTEM_TG_ACCOUNT_IDS:
                result["error"] = "Cannot target anonymous admin or Telegram system accounts."
                return result
            cm = await get_chat_member_safe(context, chat.id, u.id)
            db.upsert_member(
                chat.id,
                u.id,
                u.username,
                u.full_name,
                is_bot=u.is_bot,
                is_active=bool(not cm or cm.status not in (ChatMemberStatus.LEFT, ChatMemberStatus.BANNED)),
            )
            result.update(
                {
                    "uid": u.id,
                    "name": u.full_name,
                    "username": u.username,
                    "member_cm": cm,
                    "resolved_from_reply": True,
                    "remaining_args": args,
                }
            )
            return result

    raw_text = msg.text or msg.caption or ""
    for ent in (msg.entities or ()) + (msg.caption_entities or ()):
        if ent.type == "text_mention" and ent.user:
            u = ent.user
            cm = await get_chat_member_safe(context, chat.id, u.id)
            db.upsert_member(
                chat.id,
                u.id,
                u.username,
                u.full_name,
                is_bot=u.is_bot,
                is_active=bool(not cm or cm.status not in (ChatMemberStatus.LEFT, ChatMemberStatus.BANNED)),
            )
            tail = raw_text[ent.offset + ent.length :].strip()
            result.update(
                {
                    "uid": u.id,
                    "name": u.full_name,
                    "username": u.username,
                    "member_cm": cm,
                    "remaining_args": tail.split() if tail else [],
                }
            )
            return result

    for idx, arg in enumerate(args):
        clean = arg.strip()
        rem = [a for i, a in enumerate(args) if i != idx]
        if clean.isdigit():
            uid = int(clean)
            if uid in SYSTEM_TG_ACCOUNT_IDS:
                result["error"] = "Cannot target anonymous admin or Telegram system accounts."
                return result
            cached = db.get_member(chat.id, uid)
            if cached or len(clean) >= 5:
                cm = await get_chat_member_safe(context, chat.id, uid)
                if cm:
                    u = cm.user
                    db.upsert_member(
                        chat.id,
                        u.id,
                        u.username,
                        u.full_name,
                        is_bot=u.is_bot,
                        is_active=cm.status not in (ChatMemberStatus.LEFT, ChatMemberStatus.BANNED),
                    )
                    result.update({"uid": u.id, "name": u.full_name, "username": u.username, "member_cm": cm, "remaining_args": rem})
                    return result
                if cached:
                    result.update({"uid": uid, "name": cached["full_name"], "username": cached["username"], "remaining_args": rem})
                    return result
                result.update({"uid": uid, "name": str(uid), "username": None, "remaining_args": rem})
                return result
        clean_at = re.sub(r"[.,:;!?]+$", "", clean)
        if clean_at.startswith("@") and len(clean_at) > 1:
            uname = clean_at[1:].lower()
            cached = db.find_member_by_username(chat.id, uname) or db.find_member_by_username_global(uname)
            if cached:
                cm = await get_chat_member_safe(context, chat.id, cached["user_id"])
                name = cm.user.full_name if cm else cached["full_name"]
                uname_resolved = cm.user.username if cm else cached["username"]
                db.upsert_member(chat.id, cached["user_id"], uname_resolved, name, is_bot=False, is_active=True)
                result.update({"uid": cached["user_id"], "name": name, "username": uname_resolved, "member_cm": cm, "remaining_args": rem})
                return result
            result["error"] = (
                f"Could not resolve @{uname} yet — Telegram's Bot API cannot look up @usernames unless that user "
                "has sent a message or joined while the bot is running. Reply to any message from them or pass their numeric User ID."
            )
            return result

    return result


async def resolve_target_user(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> Tuple[Optional[int], Optional[str], Optional[str]]:
    ctx = await resolve_target_context(update, context)
    return ctx["uid"], ctx["name"], ctx["username"]


async def send_chunked_text(message: Message, text: str) -> Optional[Message]:
    clean = text.strip() or "I could not generate a response. Please try again."
    first_sent: Optional[Message] = None
    for i in range(0, len(clean), MAX_TG_LEN):
        sent = await message.reply_text(clean[i : i + MAX_TG_LEN])
        if first_sent is None:
            first_sent = sent
    return first_sent


def is_casual_ack_or_greeting(text: str) -> bool:
    clean = text.strip()
    if not clean:
        return False
    if CASUAL_ACK_PATTERN.match(clean):
        return True
    return not any(ch.isalnum() for ch in clean)


def is_non_ca_sentinel_or_refusal(answer: str) -> bool:
    clean = answer.strip()
    if not clean:
        return False
    if clean.upper().startswith(NON_CA_SENTINEL):
        return True
    lower = clean.lower()
    return (
        len(clean) < 320
        and (
            "strictly specialized in ca" in lower
            or "only answer questions related to chartered accountancy" in lower
            or "only help with chartered accountancy" in lower
            or "only assist with ca" in lower
        )
    )


def owner_mtproto_configured() -> bool:
    return bool(TelegramClient and TELEGRAM_API_ID.isdigit() and TELEGRAM_API_HASH and OWNER_SESSION_STRING)


async def owner_edit_admin(
    chat_id: int,
    user_id: int,
    promote: bool,
    rank: str = "",
    username: Optional[str] = None,
) -> Tuple[bool, str]:
    if not owner_mtproto_configured():
        return False, "OWNER_SESSION_STRING is not configured"
    client = TelegramClient(StringSession(OWNER_SESSION_STRING), int(TELEGRAM_API_ID), TELEGRAM_API_HASH)
    try:
        await client.connect()
        try:
            channel_entity = await client.get_input_entity(chat_id)
        except Exception:
            await client.get_dialogs(limit=80)
            channel_entity = await client.get_input_entity(chat_id)

        user_entity = None
        try:
            user_entity = await client.get_input_entity(user_id)
        except Exception:
            if username:
                try:
                    user_entity = await client.get_input_entity(f"@{username.lstrip('@')}")
                except Exception:
                    user_entity = None
            if user_entity is None:
                admins = await client.get_participants(channel_entity, filter=ChannelParticipantsAdmins(), limit=200)
                matched = next((u for u in admins if u.id == user_id), None)
                user_entity = await client.get_input_entity(matched or user_id)

        rights = (
            ChatAdminRights(
                change_info=False,
                post_messages=False,
                edit_messages=False,
                delete_messages=True,
                ban_users=True,
                invite_users=True,
                pin_messages=True,
                add_admins=False,
                anonymous=False,
                manage_call=True,
                other=True,
            )
            if promote
            else ChatAdminRights()
        )
        await client(EditAdminRequest(channel=channel_entity, user_id=user_entity, admin_rights=rights, rank=rank[:16]))
        return True, "ok"
    except Exception as exc:
        err_text = str(exc)
        if "FRESH_CHANGE_ADMINS_FORBIDDEN" in err_text.upper():
            return (
                False,
                "Telegram 24h security cooldown active on this new session (FRESH_CHANGE_ADMINS_FORBIDDEN). "
                "Keep this session active (do not regenerate/re-login) and it will unlock in 24h; "
                "for immediate demotion, use the Group Owner's Telegram app under Group Settings → Administrators.",
            )
        return False, err_text
    finally:
        await client.disconnect()


def track_user_from_message(update: Update) -> None:
    chat = update.effective_chat
    user = update.effective_user
    if not chat or not user:
        return
    if chat.type in (ChatType.GROUP, ChatType.SUPERGROUP):
        db.upsert_member(
            chat_id=chat.id,
            user_id=user.id,
            username=user.username,
            full_name=user.full_name,
            is_bot=user.is_bot,
            is_active=True,
            increment_msg=True,
        )


async def start_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.effective_message
    if not msg:
        return
    bot_username = context.bot.username
    text = (
        f"Hello! I am <b>{html.escape(context.bot.first_name)}</b>\\n\\n"
        "I combine <b>Rose-style Group Management</b>, <b>Single-Message Tag All</b>, "
        "<b>Live Weather</b>, <b>Admin User Info</b>, and a <b>CA-Specialized Gemini AI Guider</b> (text & audio)!\\n\\n"
        f"<b>CA AI Study Guider:</b>\\n"
        f"• Tag <code>@{html.escape(bot_username)}</code> with any CA question or voice/audio note.\\n"
        f"• Or reply to someone's voice/audio note and tag <code>@{html.escape(bot_username)}</code>.\\n\\n"
        "Use /help to see all commands."
    )
    await msg.reply_text(text, parse_mode=ParseMode.HTML)


async def help_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.effective_message
    if not msg:
        return
    bot_user = html.escape(context.bot.username or "bot")
    text = (
        "<b>Bot Command Guide</b>\\n\\n"
        "<b>CA Exam Guider (Gemini AI - CA Only):</b>\\n"
        f"• Mention <code>@{bot_user}</code> with text or audio/voice\\n"
        f"• Reply to a voice/audio message with <code>@{bot_user}</code>\\n"
        "• In DM, simply send text or audio directly\\n\\n"
        "<b>Tag All (Admins):</b>\\n"
        "• /tagall [optional message] — Tag all group members in one message\\n\\n"
        "<b>Rose Group Moderation (Admins):</b>\\n"
        "• /ban | /tban &lt;time&gt; | /unban | /kick\\n"
        "• /mute [30m|2h|1d] | /tmute &lt;time&gt; | /unmute\\n"
        "• /promote [title] | /demote | /adminlist\\n"
        "• /warn | /warns | /resetwarns | /del\\n"
        "• /pin | /unpin\\n"
        "• /setwelcome &lt;text&gt; | /welcome on|off\\n"
        "• /setrules &lt;text&gt; | /rules\\n\\n"
        "<b>Admin User Info:</b>\\n"
        "• /info (reply / @username / user_id) — Admin only\\n\\n"
        "<b>Utilities:</b>\\n"
        "• /weather &lt;city&gt; — Live weather report\\n"
        "• /id — Get your & chat ID"
    )
    await msg.reply_text(text, parse_mode=ParseMode.HTML)


async def id_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.effective_message
    chat = update.effective_chat
    user = update.effective_user
    if not msg or not chat or not user:
        return
    real_reply = _get_real_reply_message(msg)
    if context.args or real_reply:
        target_ctx = await resolve_target_context(update, context)
        if target_ctx.get("error"):
            await msg.reply_text(html.escape(target_ctx["error"]), parse_mode=ParseMode.HTML)
            return
        if target_ctx.get("uid") is not None:
            t_uid = target_ctx["uid"]
            t_name = target_ctx.get("name") or str(t_uid)
            await msg.reply_text(
                f"<b>Chat ID:</b> <code>{chat.id}</code>\\n"
                f"<b>User ID:</b> <code>{t_uid}</code> ({mention_html(t_uid, t_name)})",
                parse_mode=ParseMode.HTML,
            )
            return
    target = real_reply.from_user if (real_reply and real_reply.from_user) else user
    await msg.reply_text(
        f"<b>Chat ID:</b> <code>{chat.id}</code>\\n"
        f"<b>User ID:</b> <code>{target.id}</code> ({mention_html(target.id, target.full_name)})",
        parse_mode=ParseMode.HTML,
    )


async def weather_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.effective_message
    if not msg:
        return
    if not context.args:
        await msg.reply_text("Usage: <code>/weather Delhi</code>", parse_mode=ParseMode.HTML)
        return

    city = " ".join(context.args).strip()
    await context.bot.send_chat_action(msg.chat_id, ChatAction.TYPING)

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            geo_resp = await client.get(
                "https://geocoding-api.open-meteo.com/v1/search",
                params={"name": city, "count": 1, "language": "en", "format": "json"},
            )
            geo_resp.raise_for_status()
            geo_data = geo_resp.json()

            results = geo_data.get("results")
            if not results:
                await msg.reply_text(f"Could not find city: <b>{html.escape(city)}</b>", parse_mode=ParseMode.HTML)
                return

            loc = results[0]
            lat, lon = loc["latitude"], loc["longitude"]
            place = ", ".join(p for p in [loc.get("name"), loc.get("admin1"), loc.get("country")] if p)

            wx_resp = await client.get(
                "https://api.open-meteo.com/v1/forecast",
                params={
                    "latitude": lat,
                    "longitude": lon,
                    "current": "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m",
                    "daily": "temperature_2m_max,temperature_2m_min",
                    "timezone": "auto",
                    "forecast_days": 1,
                },
            )
            wx_resp.raise_for_status()
            wx = wx_resp.json()

        curr = wx["current"]
        daily = wx["daily"]
        condition = WMO_CODES.get(curr.get("weather_code", -1), "Weather update")

        reply = (
            f"<b>Weather in {html.escape(place)}</b>\\n"
            f"• Condition: {condition}\\n"
            f"• Temperature: <b>{curr['temperature_2m']}°C</b> (Feels like {curr['apparent_temperature']}°C)\\n"
            f"• Min / Max: {daily['temperature_2m_min'][0]}°C / {daily['temperature_2m_max'][0]}°C\\n"
            f"• Humidity: {curr['relative_humidity_2m']}%\\n"
            f"• Wind: {curr['wind_speed_10m']} km/h"
        )
        await msg.reply_text(reply, parse_mode=ParseMode.HTML)
    except Exception as e:
        logger.exception("Weather fetch failed: %s", e)
        await msg.reply_text("Unable to fetch weather right now. Please try again shortly.")


async def tagall_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.effective_message
    chat = update.effective_chat
    if not msg or not chat or not is_group_chat(update):
        if msg:
            await msg.reply_text("This command can only be used in groups.")
        return

    if not await is_user_admin(update, context):
        await msg.reply_text("Only group admins can use /tagall.")
        return

    ok, _bot_member, debug_html = await check_bot_permissions(
        context,
        chat.id,
        ["can_delete_messages", "can_restrict_members"],
        "tagall",
    )
    if not ok:
        await msg.reply_text(debug_html, parse_mode=ParseMode.HTML)
        return

    if TELEGRAM_API_ID and TELEGRAM_API_HASH and OWNER_SESSION_STRING and TelegramClient is not None:
        try:
            async with TelegramClient(StringSession(OWNER_SESSION_STRING), int(TELEGRAM_API_ID), TELEGRAM_API_HASH) as client:
                entity = await client.get_input_entity(chat.id)
                participants = await client.get_participants(entity, limit=2000)
                for p in participants:
                    if getattr(p, "bot", False) or getattr(p, "deleted", False):
                        continue
                    fname = " ".join(x for x in [getattr(p, "first_name", None), getattr(p, "last_name", None)] if x) or getattr(p, "username", None) or "Member"
                    db.upsert_member(chat.id, p.id, getattr(p, "username", None), fname, is_bot=False, is_active=True)
        except Exception as e:
            logger.warning("Owner MTProto participant sync skipped: %s", e)

    members_map: dict[int, tuple[Optional[str], str]] = {}
    try:
        admins = await context.bot.get_chat_administrators(chat.id)
        for adm in admins:
            u = adm.user
            if not u.is_bot:
                db.upsert_member(chat.id, u.id, u.username, u.full_name, is_bot=False)
                members_map[u.id] = (u.username, u.full_name or u.first_name or "Member")
    except TelegramError as e:
        logger.warning("Could not fetch admins for tagall: %s", e)

    for m in db.get_active_members(chat.id):
        members_map.setdefault(m["user_id"], (m["username"], m["full_name"] or "Member"))

    if not members_map:
        await msg.reply_text("No active group members tracked yet.")
        return

    note = " ".join(context.args).strip() if context.args else "Attention everyone!"
    use_compact = len(members_map) > 25

    def _short_label(name: str) -> str:
        clean = " ".join((name or "Member").split())
        if not use_compact:
            return (clean[:23].rstrip() + "…") if len(clean) > 24 else clean
        first = clean.split(" ")[0] or "Member"
        return (first[:13].rstrip() + "…") if len(first) > 14 else first

    def _fmt_tag(uid: int, uname: Optional[str], name: str) -> tuple[str, int]:
        if uname:
            tag = f"@{html.escape(uname.lstrip('@'))}"
            return tag, len(uname.lstrip("@")) + 1
        label = _short_label(name)
        return mention_html(uid, label), len(label)

    # Pack up to 100 members into ONE message cleanly within Telegram limits
    raw_chunks: list[list[str]] = []
    cur_tags: list[str] = []
    cur_visible_len = 0
    cur_html_len = 0
    header_reserve = max(len(note) + 32, 64)
    effective_visible_max = max(400, TAGALL_MAX_CHARS - header_reserve)
    effective_raw_max = max(effective_visible_max, TAGALL_MAX_RAW_HTML - header_reserve * 2)

    for uid, (uname, name) in members_map.items():
        tag_str, visible_len = _fmt_tag(uid, uname, name)
        if cur_tags and (
            len(cur_tags) >= TAGALL_CHUNK_SIZE
            or cur_visible_len + visible_len + 1 > effective_visible_max
            or cur_html_len + len(tag_str) + 1 > effective_raw_max
        ):
            raw_chunks.append(cur_tags)
            cur_tags = []
            cur_visible_len = 0
            cur_html_len = 0
        cur_tags.append(tag_str)
        cur_visible_len += visible_len + 1
        cur_html_len += len(tag_str) + 1

    if cur_tags:
        raw_chunks.append(cur_tags)

    total_chunks = len(raw_chunks)
    for idx, chunk_tags in enumerate(raw_chunks, start=1):
        part_suffix = f" ({idx}/{total_chunks})" if total_chunks > 1 else ""
        header = f"<b>{html.escape(note)}{part_suffix}</b>\\n\\n"
        payload = header + " ".join(chunk_tags)
        for attempt in range(2):
            try:
                if idx == 1:
                    await msg.reply_text(payload, parse_mode=ParseMode.HTML)
                else:
                    await context.bot.send_message(
                        chat_id=chat.id,
                        text=payload,
                        parse_mode=ParseMode.HTML,
                        message_thread_id=msg.message_thread_id,
                    )
                break
            except RetryAfter as exc:
                if attempt == 0:
                    await asyncio.sleep(exc.retry_after + 1)
                else:
                    raise
        if idx < total_chunks:
            await asyncio.sleep(0.55)


async def adminlist_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.effective_message
    chat = update.effective_chat
    if not msg or not chat or not is_group_chat(update):
        return
    try:
        admins = await context.bot.get_chat_administrators(chat.id)
    except TelegramError as e:
        await msg.reply_text(f"Failed to fetch admins: {html.escape(str(e))}", parse_mode=ParseMode.HTML)
        return

    lines = []
    for adm in admins:
        u = adm.user
        if u.is_bot:
            continue
        db.upsert_member(chat.id, u.id, u.username, u.full_name, is_bot=False)
        if adm.status == ChatMemberStatus.OWNER:
            role_lbl = "Owner 👑"
        elif getattr(adm, "can_be_edited", False):
            role_lbl = "Admin · Bot-managed ✅"
        else:
            role_lbl = "Admin · Owner-promoted 🔒"
        lines.append(f"• {mention_html(u.id, u.full_name)} ({role_lbl})")

    _, _, perm_debug = await check_bot_permissions(
        context,
        chat.id,
        ["can_delete_messages", "can_restrict_members", "can_pin_messages", "can_promote_members"],
        "adminlist",
    )
    text = f"<b>Group Admins ({len(lines)})</b>\\n" + ("\\n".join(lines) or "None") + f"\\n\\n{perm_debug}"
    await msg.reply_text(text, parse_mode=ParseMode.HTML)


async def info_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.effective_message
    chat = update.effective_chat
    if not msg or not chat:
        return

    if is_group_chat(update) and not await is_user_admin(update, context):
        await msg.reply_text("Only group admins can check member info.")
        return

    target_ctx = await resolve_target_context(update, context)
    if target_ctx.get("error"):
        await msg.reply_text(html.escape(target_ctx["error"]), parse_mode=ParseMode.HTML)
        return
    uid, full_name, username = target_ctx["uid"], target_ctx["name"], target_ctx["username"]
    if uid is None:
        await msg.reply_text(
            "Usage: Reply to a user with <code>/info</code> or pass <code>/info @username</code> or <code>/info 123456789</code>.",
            parse_mode=ParseMode.HTML,
        )
        return

    role = "Unknown"
    is_bot_str = "Unknown"
    try:
        cm: ChatMember = await context.bot.get_chat_member(chat.id, uid)
        role = cm.status.value.capitalize()
        full_name = cm.user.full_name
        username = cm.user.username
        is_bot_str = "Yes" if cm.user.is_bot else "No"
        db.upsert_member(chat.id, uid, username, full_name, is_bot=cm.user.is_bot)
    except TelegramError:
        pass

    record = db.get_member(chat.id, uid)
    warns = record["warns"] if record else 0
    msg_count = record["msg_count"] if record else 0
    first_seen = record["first_seen"] if record else "N/A"
    last_seen = record["last_seen"] if record else "N/A"
    uname_display = f"@{html.escape(username)}" if username else "None"

    info_text = (
        "<b>User Information</b>\\n"
        f"• <b>Name:</b> {mention_html(uid, full_name or 'User')}\\n"
        f"• <b>User ID:</b> <code>{uid}</code>\\n"
        f"• <b>Username:</b> {uname_display}\\n"
        f"• <b>Group Role:</b> {html.escape(role)}\\n"
        f"• <b>Is Bot:</b> {is_bot_str}\\n"
        f"• <b>Warnings:</b> {warns}/3\\n"
        f"• <b>Tracked Messages:</b> {msg_count}\\n"
        f"• <b>First Seen:</b> {html.escape(first_seen)}\\n"
        f"• <b>Last Seen:</b> {html.escape(last_seen)}"
    )
    await msg.reply_text(info_text, parse_mode=ParseMode.HTML)


async def _check_mod_ready(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    command_name: str,
    required_bot_rights: list[str],
    required_actor_right: Optional[str] = None,
) -> Optional[ChatMember]:
    msg = update.effective_message
    chat = update.effective_chat
    if not msg or not chat or not is_group_chat(update):
        if msg:
            await msg.reply_text("This command works only in groups.")
        return None
    if not await is_user_admin(update, context):
        await msg.reply_text("You must be a group admin to use this command.")
        return None
    if required_actor_right and not await is_user_admin(update, context, required_right=required_actor_right):
        await msg.reply_text(f"You lack the required admin permission for /{html.escape(command_name)}.", parse_mode=ParseMode.HTML)
        return None
    ok, bot_member, debug_html = await check_bot_permissions(context, chat.id, required_bot_rights, command_name)
    if not ok:
        await msg.reply_text(debug_html, parse_mode=ParseMode.HTML)
        return None
    return bot_member


async def _verify_target_context(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    action: str,
    target_ctx: dict,
) -> Tuple[bool, Optional[ChatMember], str]:
    msg = update.effective_message
    chat = update.effective_chat
    if not msg or not chat:
        return False, None, "Invalid chat context."
    if target_ctx.get("error"):
        return False, None, target_ctx["error"]

    uid = target_ctx.get("uid")
    if uid is None:
        return False, None, f"Reply to a user or pass @username/ID for /{action}."

    actor_id = update.effective_user.id if update.effective_user else None
    if uid == context.bot.id:
        return False, None, f"I cannot /{action} myself."
    if uid in SYSTEM_TG_ACCOUNT_IDS:
        return False, None, "Cannot target anonymous admin or Telegram system accounts."
    if actor_id is not None and uid == actor_id and action not in ("unban", "unmute"):
        return False, None, f"You cannot /{action} yourself."

    cm = target_ctx.get("member_cm") or await get_chat_member_safe(context, chat.id, uid)
    name_html = mention_html(uid, target_ctx.get("name") or "User")
    status = cm.status if cm else None
    is_target_owner = status == ChatMemberStatus.OWNER
    is_target_admin = status in (ChatMemberStatus.OWNER, ChatMemberStatus.ADMINISTRATOR)

    if action in ("ban", "kick", "mute", "warn"):
        if is_target_admin:
            role_txt = "group creator" if is_target_owner else "group administrator"
            return False, cm, f"Cannot {action} a {role_txt}."
        if action in ("kick", "mute") and status in (ChatMemberStatus.LEFT, ChatMemberStatus.BANNED):
            return False, cm, f"Cannot {action} {name_html}: user is not currently in the group."
        if action == "mute" and chat.type != ChatType.SUPERGROUP:
            return False, cm, "Temporary/permission mutes require the group to be a Telegram Supergroup."
        return True, cm, ""

    if action == "unban":
        if cm and status not in (ChatMemberStatus.BANNED, ChatMemberStatus.LEFT):
            return False, cm, f"{name_html} is not banned in this group."
        return True, cm, ""

    if action == "unmute":
        if is_target_admin:
            return False, cm, f"{name_html} is an admin and cannot be muted/unmuted."
        if chat.type != ChatType.SUPERGROUP:
            return False, cm, "Unmute requires the group to be a Telegram Supergroup."
        return True, cm, ""

    if action == "promote":
        if chat.type != ChatType.SUPERGROUP:
            return False, cm, "Granular /promote requires the group to be upgraded to a Telegram Supergroup."
        if is_target_owner:
            return False, cm, "Cannot modify the group creator."
        if cm and cm.user.is_bot:
            return False, cm, "Cannot promote another bot via /promote; manage bot admins in Telegram Group Settings."
        if cm and status in (ChatMemberStatus.LEFT, ChatMemberStatus.BANNED):
            return False, cm, f"Cannot promote {name_html}: user must be an active group member first."
        if cm is None:
            return False, None, f"Cannot promote {name_html}: user was not found in this group."
        return True, cm, ""

    if action == "demote":
        if chat.type != ChatType.SUPERGROUP:
            return False, cm, "Granular /demote requires the group to be upgraded to a Telegram Supergroup."
        if is_target_owner:
            return False, cm, "Cannot demote the group creator."
        if not cm or status != ChatMemberStatus.ADMINISTRATOR:
            return False, cm, f"{name_html} is not an administrator."
        return True, cm, ""

    return True, cm, ""


async def ban_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.effective_message
    cmd_name = ((msg.text or "/ban").split()[0].lstrip("/").split("@")[0].lower()) if msg else "ban"
    if not await _check_mod_ready(update, context, cmd_name, ["can_restrict_members"], "can_restrict_members"):
        return
    msg, chat = update.effective_message, update.effective_chat
    target_ctx = await resolve_target_context(update, context)
    ok, _cm, err_html = await _verify_target_context(update, context, "ban", target_ctx)
    if not ok:
        await msg.reply_text(err_html, parse_mode=ParseMode.HTML)
        return
    uid, name = target_ctx["uid"], target_ctx["name"]
    mins = extract_duration_minutes(target_ctx["remaining_args"], target_ctx["resolved_from_reply"], uid)
    if cmd_name == "tban" and not mins:
        await msg.reply_text(
            "Usage: <code>/tban @user &lt;time&gt;</code> (e.g. <code>30m</code>, <code>2h</code>, <code>1d</code>). Use <code>/ban</code> for a permanent ban.",
            parse_mode=ParseMode.HTML,
        )
        return
    until_date = datetime.now(timezone.utc) + timedelta(minutes=mins) if mins else None
    try:
        await context.bot.ban_chat_member(chat.id, uid, until_date=until_date)
        db.mark_member_inactive(chat.id, uid)
        dur_txt = f" for {mins} min" if mins else ""
        await msg.reply_text(f"Banned {mention_html(uid, name or 'User')}{dur_txt}.", parse_mode=ParseMode.HTML)
    except TelegramError as e:
        await msg.reply_text(
            _format_telegram_mod_error("ban", mention_html(uid, name or "User"), e, cmd_name),
            parse_mode=ParseMode.HTML,
        )


async def unban_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _check_mod_ready(update, context, "unban", ["can_restrict_members"], "can_restrict_members"):
        return
    msg, chat = update.effective_message, update.effective_chat
    target_ctx = await resolve_target_context(update, context)
    ok, _cm, err_html = await _verify_target_context(update, context, "unban", target_ctx)
    if not ok:
        await msg.reply_text(err_html, parse_mode=ParseMode.HTML)
        return
    uid, name = target_ctx["uid"], target_ctx["name"]
    try:
        await context.bot.unban_chat_member(chat.id, uid, only_if_banned=True)
        db.upsert_member(chat.id, uid, target_ctx.get("username"), name or "User", is_active=True)
        await msg.reply_text(f"Unbanned {mention_html(uid, name or 'User')}.", parse_mode=ParseMode.HTML)
    except TelegramError as e:
        await msg.reply_text(
            _format_telegram_mod_error("unban", mention_html(uid, name or "User"), e, "unban"),
            parse_mode=ParseMode.HTML,
        )


async def kick_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _check_mod_ready(update, context, "kick", ["can_restrict_members"], "can_restrict_members"):
        return
    msg, chat = update.effective_message, update.effective_chat
    target_ctx = await resolve_target_context(update, context)
    ok, _cm, err_html = await _verify_target_context(update, context, "kick", target_ctx)
    if not ok:
        await msg.reply_text(err_html, parse_mode=ParseMode.HTML)
        return
    uid, name = target_ctx["uid"], target_ctx["name"]
    try:
        await context.bot.ban_chat_member(chat.id, uid)
    except TelegramError as e:
        await msg.reply_text(
            _format_telegram_mod_error("kick", mention_html(uid, name or "User"), e, "kick"),
            parse_mode=ParseMode.HTML,
        )
        return
    try:
        await context.bot.unban_chat_member(chat.id, uid, only_if_banned=True)
    except TelegramError:
        pass
    db.mark_member_inactive(chat.id, uid)
    await msg.reply_text(f"Kicked {mention_html(uid, name or 'User')}.", parse_mode=ParseMode.HTML)


async def mute_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.effective_message
    cmd_name = ((msg.text or "/mute").split()[0].lstrip("/").split("@")[0].lower()) if msg else "mute"
    if not await _check_mod_ready(update, context, cmd_name, ["can_restrict_members"], "can_restrict_members"):
        return
    msg, chat = update.effective_message, update.effective_chat
    target_ctx = await resolve_target_context(update, context)
    ok, _cm, err_html = await _verify_target_context(update, context, "mute", target_ctx)
    if not ok:
        await msg.reply_text(err_html, parse_mode=ParseMode.HTML)
        return
    uid, name = target_ctx["uid"], target_ctx["name"]
    minutes = extract_duration_minutes(target_ctx["remaining_args"], target_ctx["resolved_from_reply"], uid)
    if cmd_name == "tmute" and not minutes:
        await msg.reply_text(
            "Usage: <code>/tmute @user &lt;time&gt;</code> (e.g. <code>30m</code>, <code>2h</code>, <code>1d</code>). Use <code>/mute</code> for a permanent mute.",
            parse_mode=ParseMode.HTML,
        )
        return
    until_date = datetime.now(timezone.utc) + timedelta(minutes=minutes) if minutes else None
    try:
        await context.bot.restrict_chat_member(
            chat.id, uid, permissions=MUTE_PERMISSIONS, until_date=until_date
        )
        dur_txt = f" for {minutes} min" if minutes else ""
        await msg.reply_text(f"Muted {mention_html(uid, name or 'User')}{dur_txt}.", parse_mode=ParseMode.HTML)
    except TelegramError as e:
        await msg.reply_text(
            _format_telegram_mod_error("mute", mention_html(uid, name or "User"), e, cmd_name),
            parse_mode=ParseMode.HTML,
        )


async def unmute_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _check_mod_ready(update, context, "unmute", ["can_restrict_members"], "can_restrict_members"):
        return
    msg, chat = update.effective_message, update.effective_chat
    target_ctx = await resolve_target_context(update, context)
    ok, _cm, err_html = await _verify_target_context(update, context, "unmute", target_ctx)
    if not ok:
        await msg.reply_text(err_html, parse_mode=ParseMode.HTML)
        return
    uid, name = target_ctx["uid"], target_ctx["name"]
    try:
        restore_perms = UNMUTE_PERMISSIONS
        try:
            chat_obj = await context.bot.get_chat(chat.id)
            if chat_obj.permissions:
                restore_perms = chat_obj.permissions
        except TelegramError:
            pass
        await context.bot.restrict_chat_member(chat.id, uid, permissions=restore_perms)
        await msg.reply_text(f"Unmuted {mention_html(uid, name or 'User')}.", parse_mode=ParseMode.HTML)
    except TelegramError as e:
        await msg.reply_text(
            _format_telegram_mod_error("unmute", mention_html(uid, name or "User"), e, "unmute"),
            parse_mode=ParseMode.HTML,
        )


async def promote_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    bot_member = await _check_mod_ready(update, context, "promote", ["can_promote_members"], "can_promote_members")
    if not bot_member:
        return
    msg, chat = update.effective_message, update.effective_chat
    target_ctx = await resolve_target_context(update, context)
    ok, target_cm, err_html = await _verify_target_context(update, context, "promote", target_ctx)
    if not ok:
        await msg.reply_text(err_html, parse_mode=ParseMode.HTML)
        return

    uid, name = target_ctx["uid"], target_ctx["name"]
    custom_title = " ".join(target_ctx["remaining_args"]).strip()[:16]

    if (
        target_cm
        and target_cm.status == ChatMemberStatus.ADMINISTRATOR
        and not getattr(target_cm, "can_be_edited", True)
    ):
        if owner_mtproto_configured():
            ok_owner, owner_err = await owner_edit_admin(
                chat.id, uid, promote=True, rank=custom_title, username=target_ctx.get("username")
            )
            if ok_owner:
                title_txt = f" (Title: <code>{html.escape(custom_title)}</code>)" if custom_title else ""
                await msg.reply_text(
                    f"Promoted {mention_html(uid, name or 'User')} via Owner session{title_txt}.",
                    parse_mode=ParseMode.HTML,
                )
                return
            await msg.reply_text(f"Owner session /promote failed: {html.escape(owner_err)}", parse_mode=ParseMode.HTML)
            return

        await msg.reply_text(
            f"{mention_html(uid, name or 'User')} is an <b>Owner-promoted Admin 🔒</b> (<code>can_be_edited: false</code>).\\n\\n"
            "Telegram's Bot API blocks any bot from editing admins promoted by the Group Owner. "
            "Set <code>OWNER_SESSION_STRING</code> in <code>.env</code> to edit any old admin, or ask the Group Owner to dismiss & re-promote via <code>/promote</code>.",
            parse_mode=ParseMode.HTML,
        )
        return

    rights_ok, grant_rights, rights_err_html = evaluate_promote_bot_rights(bot_member)
    if not rights_ok:
        await msg.reply_text(rights_err_html, parse_mode=ParseMode.HTML)
        return

    try:
        await context.bot.promote_chat_member(
            chat_id=chat.id,
            user_id=uid,
            can_manage_chat=grant_rights["can_manage_chat"],
            can_delete_messages=grant_rights["can_delete_messages"],
            can_manage_video_chats=grant_rights["can_manage_video_chats"],
            can_restrict_members=grant_rights["can_restrict_members"],
            can_invite_users=grant_rights["can_invite_users"],
            can_pin_messages=grant_rights["can_pin_messages"],
            can_promote_members=False,
        )
        if custom_title:
            try:
                await context.bot.set_chat_administrator_custom_title(chat.id, uid, custom_title)
            except TelegramError:
                pass
        title_txt = f" (Title: <code>{html.escape(custom_title)}</code>)" if custom_title else ""
        await msg.reply_text(
            f"Promoted {mention_html(uid, name or 'User')} to <b>Administrator</b>{title_txt}.",
            parse_mode=ParseMode.HTML,
        )
    except TelegramError as e:
        err_str = str(e)
        if "CHAT_ADMIN_REQUIRED" in err_str or "not enough rights" in err_str.lower():
            await msg.reply_text(
                "Telegram rejected /promote (<code>CHAT_ADMIN_REQUIRED</code>): ensure I hold every admin permission I am trying to grant.",
                parse_mode=ParseMode.HTML,
            )
        else:
            await msg.reply_text(f"Failed to promote: {html.escape(err_str)}", parse_mode=ParseMode.HTML)


async def demote_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _check_mod_ready(update, context, "demote", ["can_promote_members"], "can_promote_members"):
        return
    msg, chat = update.effective_message, update.effective_chat
    target_ctx = await resolve_target_context(update, context)
    ok, target_cm, err_html = await _verify_target_context(update, context, "demote", target_ctx)
    if not ok:
        await msg.reply_text(err_html, parse_mode=ParseMode.HTML)
        return

    uid, name = target_ctx["uid"], target_ctx["name"]
    owner_lock_msg = (
        f"Cannot demote {mention_html(uid, name or 'User')}: Telegram enforces <code>can_be_edited: false</code> on admins promoted by the Group Owner or another admin — no Bot API token can override this.\\n\\n"
        "<b>2 ways to demote old admins:</b>\\n"
        "1. <b>Telegram App:</b> Group Owner removes them once under Group Settings → Administrators (anyone promoted via <code>/promote</code> afterwards can be demoted anytime).\\n"
        "2. <b>Owner MTProto Mode:</b> Set <code>TELEGRAM_API_ID</code>, <code>TELEGRAM_API_HASH</code>, and <code>OWNER_SESSION_STRING</code> in <code>.env</code> so this command runs with Owner rights."
    )

    if target_cm and not getattr(target_cm, "can_be_edited", True):
        if owner_mtproto_configured():
            ok_owner, owner_err = await owner_edit_admin(
                chat.id, uid, promote=False, username=target_ctx.get("username")
            )
            if ok_owner:
                await msg.reply_text(
                    f"Demoted {mention_html(uid, name or 'User')} to regular member (via Owner session).",
                    parse_mode=ParseMode.HTML,
                )
                return
            await msg.reply_text(f"Owner session /demote failed: {html.escape(owner_err)}", parse_mode=ParseMode.HTML)
            return
        await msg.reply_text(owner_lock_msg, parse_mode=ParseMode.HTML)
        return

    try:
        await context.bot.promote_chat_member(
            chat_id=chat.id,
            user_id=uid,
            can_manage_chat=False,
            can_delete_messages=False,
            can_manage_video_chats=False,
            can_restrict_members=False,
            can_promote_members=False,
            can_change_info=False,
            can_invite_users=False,
            can_pin_messages=False,
            can_manage_topics=False,
        )
        await msg.reply_text(f"Demoted {mention_html(uid, name or 'User')} to regular member.", parse_mode=ParseMode.HTML)
    except TelegramError as e:
        err_str = str(e)
        if "CHAT_ADMIN_REQUIRED" in err_str or "not enough rights" in err_str.lower() or "right_forbidden" in err_str.lower():
            if owner_mtproto_configured():
                ok_owner, owner_err = await owner_edit_admin(
                    chat.id, uid, promote=False, username=target_ctx.get("username")
                )
                if ok_owner:
                    await msg.reply_text(
                        f"Demoted {mention_html(uid, name or 'User')} to regular member (via Owner session).",
                        parse_mode=ParseMode.HTML,
                    )
                    return
            await msg.reply_text(owner_lock_msg, parse_mode=ParseMode.HTML)
        else:
            await msg.reply_text(f"Failed to demote: {html.escape(err_str)}", parse_mode=ParseMode.HTML)


async def warn_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _check_mod_ready(update, context, "warn", ["can_restrict_members"], "can_restrict_members"):
        return
    msg, chat = update.effective_message, update.effective_chat
    target_ctx = await resolve_target_context(update, context)
    ok, _cm, err_html = await _verify_target_context(update, context, "warn", target_ctx)
    if not ok:
        await msg.reply_text(err_html, parse_mode=ParseMode.HTML)
        return
    uid, name, username = target_ctx["uid"], target_ctx["name"], target_ctx["username"]

    db.upsert_member(chat.id, uid, username, name or "User")
    warns = db.add_warn(chat.id, uid)
    max_warns = db.get_group_settings(chat.id)["max_warns"]

    if warns >= max_warns:
        try:
            await context.bot.ban_chat_member(chat.id, uid)
            db.reset_warns(chat.id, uid)
            db.mark_member_inactive(chat.id, uid)
            await msg.reply_text(
                f"{mention_html(uid, name or 'User')} reached {warns}/{max_warns} warnings and has been <b>banned</b>!",
                parse_mode=ParseMode.HTML,
            )
        except TelegramError as e:
            await msg.reply_text(f"Max warns reached, but ban failed: {html.escape(str(e))}", parse_mode=ParseMode.HTML)
    else:
        await msg.reply_text(
            f"{mention_html(uid, name or 'User')} has been warned ({warns}/{max_warns}).",
            parse_mode=ParseMode.HTML,
        )


async def warns_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg, chat = update.effective_message, update.effective_chat
    if not msg or not chat or not is_group_chat(update):
        if msg:
            await msg.reply_text("This command works only in groups.")
        return
    u = update.effective_user
    uid = u.id if u else None
    name = u.full_name if u else "User"
    real_reply = _get_real_reply_message(msg)
    if context.args or real_reply:
        target_ctx = await resolve_target_context(update, context)
        if target_ctx.get("error"):
            await msg.reply_text(html.escape(target_ctx["error"]), parse_mode=ParseMode.HTML)
            return
        if target_ctx.get("uid") is not None:
            uid, name = target_ctx["uid"], target_ctx.get("name") or "User"
    if uid is None:
        return
    rec = db.get_member(chat.id, uid)
    warns = rec["warns"] if rec else 0
    max_warns = db.get_group_settings(chat.id)["max_warns"]
    await msg.reply_text(f"{mention_html(uid, name or 'User')} has <b>{warns}/{max_warns}</b> warnings.", parse_mode=ParseMode.HTML)


async def resetwarns_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _check_mod_ready(update, context, "resetwarns", ["can_restrict_members"]):
        return
    msg, chat = update.effective_message, update.effective_chat
    target_ctx = await resolve_target_context(update, context)
    if target_ctx.get("error"):
        await msg.reply_text(html.escape(target_ctx["error"]), parse_mode=ParseMode.HTML)
        return
    uid, name = target_ctx["uid"], target_ctx["name"]
    if uid is None:
        await msg.reply_text("Reply to a user or provide ID/@username to reset warnings.")
        return
    db.reset_warns(chat.id, uid)
    await msg.reply_text(f"Warnings reset for {mention_html(uid, name or 'User')}.", parse_mode=ParseMode.HTML)


async def del_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _check_mod_ready(update, context, "del", ["can_delete_messages"], "can_delete_messages"):
        return
    msg = update.effective_message
    real_reply = _get_real_reply_message(msg)
    if not real_reply:
        await msg.reply_text("Reply to a message to delete it.")
        return
    try:
        await real_reply.delete()
        try:
            await msg.delete()
        except TelegramError:
            pass
    except TelegramError as e:
        await msg.reply_text(_format_telegram_mod_error("delete", None, e, "del"), parse_mode=ParseMode.HTML)


async def pin_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _check_mod_ready(update, context, "pin", ["can_pin_messages"], "can_pin_messages"):
        return
    msg = update.effective_message
    real_reply = _get_real_reply_message(msg)
    if not real_reply:
        await msg.reply_text("Reply to a message to pin it.")
        return
    loud = bool(context.args and context.args[0].lower() in ("loud", "notify"))
    try:
        await context.bot.pin_chat_message(
            msg.chat_id, real_reply.message_id, disable_notification=not loud
        )
        await msg.reply_text("Pinned message successfully.")
    except TelegramError as e:
        await msg.reply_text(_format_telegram_mod_error("pin", None, e, "pin"), parse_mode=ParseMode.HTML)


async def unpin_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _check_mod_ready(update, context, "unpin", ["can_pin_messages"], "can_pin_messages"):
        return
    msg = update.effective_message
    real_reply = _get_real_reply_message(msg)
    try:
        target_id = real_reply.message_id if real_reply else None
        await context.bot.unpin_chat_message(msg.chat_id, message_id=target_id)
        await msg.reply_text("Unpinned successfully.")
    except TelegramError as e:
        await msg.reply_text(_format_telegram_mod_error("unpin", None, e, "unpin"), parse_mode=ParseMode.HTML)


async def setwelcome_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg, chat = update.effective_message, update.effective_chat
    if not msg or not chat or not is_group_chat(update):
        return
    if not await is_user_admin(update, context):
        await msg.reply_text("Only admins can set the welcome message.")
        return
    if not context.args:
        await msg.reply_text(
            "Usage: <code>/setwelcome Hello {name}! How are you doing? Welcome to {chat_title}!</code>",
            parse_mode=ParseMode.HTML,
        )
        return
    db.set_welcome(chat.id, " ".join(context.args))
    await msg.reply_text("Welcome message updated!")


async def welcome_toggle_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg, chat = update.effective_message, update.effective_chat
    if not msg or not chat or not is_group_chat(update):
        return
    if not await is_user_admin(update, context):
        await msg.reply_text("Only admins can toggle welcome messages.")
        return
    if not context.args or context.args[0].lower() not in ("on", "off"):
        await msg.reply_text("Usage: <code>/welcome on</code> or <code>/welcome off</code>", parse_mode=ParseMode.HTML)
        return
    enabled = context.args[0].lower() == "on"
    db.toggle_welcome(chat.id, enabled)
    await msg.reply_text(f"Welcome messages turned <b>{'ON' if enabled else 'OFF'}</b>.", parse_mode=ParseMode.HTML)


async def setrules_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg, chat = update.effective_message, update.effective_chat
    if not msg or not chat or not is_group_chat(update):
        return
    if not await is_user_admin(update, context):
        await msg.reply_text("Only admins can set rules.")
        return
    if not context.args:
        await msg.reply_text("Usage: <code>/setrules No spam, stay focused on CA prep!</code>", parse_mode=ParseMode.HTML)
        return
    db.set_rules(chat.id, " ".join(context.args))
    await msg.reply_text("Group rules updated!")


async def rules_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg, chat = update.effective_message, update.effective_chat
    if not msg or not chat or not is_group_chat(update):
        return
    rules = db.get_group_settings(chat.id)["rules_text"]
    await msg.reply_text(f"<b>Group Rules:</b>\\n{html.escape(rules)}", parse_mode=ParseMode.HTML)


async def on_new_members(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg, chat = update.effective_message, update.effective_chat
    if not msg or not chat or not msg.new_chat_members:
        return

    settings = db.get_group_settings(chat.id)
    for member in msg.new_chat_members:
        db.upsert_member(chat.id, member.id, member.username, member.full_name, is_bot=member.is_bot, is_active=True)
        if member.id == context.bot.id:
            bot_greeting = (
                f"Hello everyone! How are you all doing? Happy to join {html.escape(chat.title)}!"
                if chat.title
                else "Hello everyone! How are you all doing? Happy to be here!"
            )
            await msg.reply_text(
                bot_greeting,
                parse_mode=ParseMode.HTML,
            )
            continue
        if settings["welcome_enabled"] and not member.is_bot:
            template = settings["welcome_text"]
            rendered = (
                html.escape(template)
                .replace("{mention}", mention_html(member.id, member.full_name))
                .replace("{name}", html.escape(member.full_name))
                .replace("{chat_title}", html.escape(chat.title or "this group"))
            )
            await msg.reply_text(rendered, parse_mode=ParseMode.HTML)


async def on_left_member(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg, chat = update.effective_message, update.effective_chat
    if msg and chat and msg.left_chat_member:
        db.mark_member_inactive(chat.id, msg.left_chat_member.id)


async def on_reaction_update(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    mr = update.message_reaction
    if not mr or not mr.user or mr.user.is_bot:
        return
    if mr.chat.type in (ChatType.GROUP, ChatType.SUPERGROUP):
        u = mr.user
        db.upsert_member(mr.chat.id, u.id, u.username, u.full_name, is_bot=False, is_active=True)


async def on_chat_member_update(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    cmu = update.chat_member
    if not cmu:
        return
    chat, user = cmu.chat, cmu.new_chat_member.user
    status = cmu.new_chat_member.status
    if status in (ChatMemberStatus.MEMBER, ChatMemberStatus.ADMINISTRATOR, ChatMemberStatus.OWNER, ChatMemberStatus.RESTRICTED):
        db.upsert_member(chat.id, user.id, user.username, user.full_name, is_bot=user.is_bot, is_active=True)
    elif status in (ChatMemberStatus.LEFT, ChatMemberStatus.BANNED):
        db.mark_member_inactive(chat.id, user.id)


def _is_bot_mentioned_or_replied(
    msg: Message, bot_username: Optional[str], bot_id: int, chat_id: int
) -> bool:
    if msg.chat.type == ChatType.PRIVATE:
        return True
    real_reply = _get_real_reply_message(msg)
    if real_reply and real_reply.from_user and real_reply.from_user.id == bot_id:
        if db.is_bot_ca_message(chat_id, real_reply.message_id):
            return True
    text_blob = (msg.text or "") + " " + (msg.caption or "")
    if bot_username and re.search(rf"@{re.escape(bot_username)}\\b", text_blob, flags=re.IGNORECASE):
        return True
    return False


def _extract_audio_attachment(msg: Message) -> Tuple[Optional[str], str, int]:
    for candidate in (msg, _get_real_reply_message(msg)):
        if not candidate:
            continue
        if candidate.voice:
            return candidate.voice.file_id, candidate.voice.mime_type or "audio/ogg", candidate.voice.file_size or 0
        if candidate.audio:
            return candidate.audio.file_id, candidate.audio.mime_type or "audio/mpeg", candidate.audio.file_size or 0
    return None, "", 0


async def ask_gemini_ca(prompt_text: str, audio_bytes: Optional[bytes] = None, audio_mime: str = "audio/ogg") -> str:
    parts = []
    if audio_bytes:
        parts.append(types.Part.from_bytes(data=audio_bytes, mime_type=audio_mime))

    user_prompt = prompt_text.strip()
    if not user_prompt and audio_bytes:
        user_prompt = (
            "Listen to this audio carefully and respond as my CA exam study guider. "
            "If the speaker asks a CA doubt, answer it clearly. If they are reciting a CA answer/concept, evaluate and correct it."
        )
    parts.append(user_prompt)

    def _call() -> str:
        candidates = []
        for m in [GEMINI_MODEL, "gemini-4-hydrogen", GEMINI_FALLBACK_MODEL]:
            if m and m not in candidates:
                candidates.append(m)
        candidates.append(GEMINI_FALLBACK_MODEL)

        last_err: Optional[Exception] = None
        for idx, model_name in enumerate(candidates):
            try:
                cfg_kwargs = {"system_instruction": CA_SYSTEM_INSTRUCTION}
                if model_name.startswith("gemini-4-"):
                    cfg_kwargs["thinking_config"] = types.ThinkingConfig(thinking_level="LOW")
                response = gemini_client.models.generate_content(
                    model=model_name,
                    contents=parts,
                    config=types.GenerateContentConfig(**cfg_kwargs),
                )
                return (response.text or "").strip()
            except Exception as err:
                last_err = err
                err_str = str(err).upper()
                retryable = any(k in err_str for k in ("503", "UNAVAILABLE", "429", "RESOURCE_EXHAUSTED", "500", "404", "NOT_FOUND", "TIMEOUT"))
                logger.warning("Gemini attempt %d (%s) failed: %s", idx + 1, model_name, err)
                if not retryable:
                    raise
                if idx < len(candidates) - 1:
                    time.sleep(0.5)
        if last_err:
            raise last_err
        return ""

    return await asyncio.to_thread(_call)


async def handle_messages(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.effective_message
    chat = update.effective_chat
    if not msg or not chat:
        return

    track_user_from_message(update)
    real_reply = _get_real_reply_message(msg)
    if real_reply and real_reply.from_user and is_group_chat(update):
        ru = real_reply.from_user
        if not ru.is_bot:
            db.upsert_member(chat.id, ru.id, ru.username, ru.full_name, is_bot=False, is_active=True)

    bot_username = context.bot.username
    if not _is_bot_mentioned_or_replied(msg, bot_username, context.bot.id, chat.id):
        return

    raw_text = msg.text or msg.caption or ""
    if bot_username:
        cleaned_text = re.sub(rf"@{re.escape(bot_username)}\\b", "", raw_text, flags=re.IGNORECASE).strip()
    else:
        cleaned_text = raw_text.strip()

    if real_reply and (real_reply.text or real_reply.caption) and not (
        real_reply.from_user and real_reply.from_user.id == context.bot.id
    ):
        replied_txt = (real_reply.text or real_reply.caption or "").strip()
        if replied_txt:
            cleaned_text = f"Referenced message: {replied_txt}\\n\\nUser request: {cleaned_text}".strip()

    file_id, mime_type, file_size = _extract_audio_attachment(msg)
    if not file_id and is_casual_ack_or_greeting(cleaned_text):
        return

    is_private = chat.type == ChatType.PRIVATE
    sender_uid = update.effective_user.id if update.effective_user else chat.id

    if not cleaned_text and not file_id:
        if not is_private and db.has_ca_notice_sent(chat.id, sender_uid):
            return
        db.mark_ca_notice_sent(chat.id, sender_uid)
        await msg.reply_text(CA_ONE_TIME_NOTICE)
        return

    await context.bot.send_chat_action(msg.chat_id, ChatAction.TYPING)

    audio_bytes: Optional[bytes] = None
    if file_id:
        if file_size > MAX_AUDIO_BYTES:
            await msg.reply_text("Audio file is larger than 20 MB. Please send a shorter voice/audio clip.")
            return
        try:
            tg_file = await context.bot.get_file(file_id)
            audio_bytes = bytes(await tg_file.download_as_bytearray())
        except Exception as e:
            logger.exception("Failed to download Telegram audio: %s", e)
            await msg.reply_text("Failed to download the audio file. Please try again.")
            return

    try:
        answer = await ask_gemini_ca(cleaned_text, audio_bytes=audio_bytes, audio_mime=mime_type)
        if is_non_ca_sentinel_or_refusal(answer):
            if not is_private and db.has_ca_notice_sent(chat.id, sender_uid):
                return
            db.mark_ca_notice_sent(chat.id, sender_uid)
            await msg.reply_text(CA_ONE_TIME_NOTICE)
            return
        sent_msg = await send_chunked_text(msg, answer)
        if sent_msg:
            db.mark_bot_ca_message(chat.id, sent_msg.message_id)
    except Exception as e:
        logger.exception("Gemini error: %s", e)
        await msg.reply_text("Gemini AI encountered an error. Please try again in a moment.")


async def error_handler(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
    logger.error("Unhandled exception while processing update %s", update, exc_info=context.error)


def _start_health_server_if_port_set() -> None:
    """Expose a tiny stdlib HTTP health endpoint when a cloud host injects PORT."""
    port_raw = os.getenv("PORT", "").strip()
    if not port_raw:
        return
    try:
        port = int(port_raw)
    except ValueError:
        return

    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class _HealthHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            if self.path in ("/", "/health", "/healthz"):
                body = b'{"ok":true,"service":"ca-rose-bot"}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            else:
                self.send_response(404)
                self.end_headers()

        def log_message(self, format: str, *args) -> None:  # noqa: A002
            return

    server = ThreadingHTTPServer(("0.0.0.0", port), _HealthHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    logger.info("Health endpoint listening on 0.0.0.0:%s (/healthz)", port)


def main() -> None:
    app = (
        Application.builder()
        .token(TELEGRAM_BOT_TOKEN)
        .connect_timeout(15.0)
        .read_timeout(25.0)
        .write_timeout(20.0)
        .pool_timeout(15.0)
        .get_updates_read_timeout(20.0)
        .build()
    )

    app.add_handler(CommandHandler("start", start_cmd))
    app.add_handler(CommandHandler("help", help_cmd))
    app.add_handler(CommandHandler("id", id_cmd))
    app.add_handler(CommandHandler("weather", weather_cmd))
    app.add_handler(CommandHandler("tagall", tagall_cmd))
    app.add_handler(CommandHandler(["adminlist", "admins"], adminlist_cmd))
    app.add_handler(CommandHandler("info", info_cmd))

    app.add_handler(CommandHandler(["ban", "tban"], ban_cmd))
    app.add_handler(CommandHandler("unban", unban_cmd))
    app.add_handler(CommandHandler("kick", kick_cmd))
    app.add_handler(CommandHandler(["mute", "tmute"], mute_cmd))
    app.add_handler(CommandHandler("unmute", unmute_cmd))
    app.add_handler(CommandHandler("promote", promote_cmd))
    app.add_handler(CommandHandler("demote", demote_cmd))
    app.add_handler(CommandHandler("warn", warn_cmd))
    app.add_handler(CommandHandler("warns", warns_cmd))
    app.add_handler(CommandHandler("resetwarns", resetwarns_cmd))
    app.add_handler(CommandHandler("del", del_cmd))
    app.add_handler(CommandHandler("pin", pin_cmd))
    app.add_handler(CommandHandler("unpin", unpin_cmd))
    app.add_handler(CommandHandler("setwelcome", setwelcome_cmd))
    app.add_handler(CommandHandler("welcome", welcome_toggle_cmd))
    app.add_handler(CommandHandler("setrules", setrules_cmd))
    app.add_handler(CommandHandler("rules", rules_cmd))

    app.add_handler(MessageHandler(filters.StatusUpdate.NEW_CHAT_MEMBERS, on_new_members))
    app.add_handler(MessageHandler(filters.StatusUpdate.LEFT_CHAT_MEMBER, on_left_member))
    app.add_handler(MessageReactionHandler(on_reaction_update))
    app.add_handler(ChatMemberHandler(on_chat_member_update, ChatMemberHandler.CHAT_MEMBER))
    app.add_handler(
        MessageHandler(
            (filters.TEXT | filters.VOICE | filters.AUDIO) & ~filters.COMMAND,
            handle_messages,
        )
    )

    _start_health_server_if_port_set()
    app.add_error_handler(error_handler)
    logger.info("Bot is starting...")
    app.run_polling(
        allowed_updates=Update.ALL_TYPES,
        drop_pending_updates=False,
        bootstrap_retries=-1,
        poll_interval=0.5,
    )


if __name__ == "__main__":
    main()
`,
  },
  {
    id: 'database.py',
    filename: 'database.py',
    language: 'python',
    description:
      'Thread-safe SQLite repository for group welcome/rules/warn limits, member tracking, message counts, and warnings.',
    content: `import sqlite3
import threading
from datetime import datetime, timezone
from typing import Optional


class Database:
    def __init__(self, db_path: str = "bot_data.db"):
        self.db_path = db_path
        self._lock = threading.Lock()
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._lock, self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS group_settings (
                    chat_id INTEGER PRIMARY KEY,
                    welcome_enabled INTEGER DEFAULT 1,
                    welcome_text TEXT DEFAULT 'Hello {name}! How are you doing? Welcome to {chat_title}!',
                    rules_text TEXT DEFAULT 'Be respectful, follow group guidelines, and stay focused!',
                    max_warns INTEGER DEFAULT 3
                );

                CREATE TABLE IF NOT EXISTS members (
                    chat_id INTEGER NOT NULL,
                    user_id INTEGER NOT NULL,
                    username TEXT,
                    full_name TEXT,
                    is_bot INTEGER DEFAULT 0,
                    is_active INTEGER DEFAULT 1,
                    msg_count INTEGER DEFAULT 0,
                    warns INTEGER DEFAULT 0,
                    first_seen TEXT,
                    last_seen TEXT,
                    PRIMARY KEY (chat_id, user_id)
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
                """
            )
            conn.commit()

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    def ensure_group(self, chat_id: int) -> None:
        with self._lock, self._connect() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO group_settings (chat_id) VALUES (?)",
                (chat_id,),
            )
            conn.commit()

    def get_group_settings(self, chat_id: int) -> dict:
        self.ensure_group(chat_id)
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM group_settings WHERE chat_id = ?", (chat_id,)
            ).fetchone()
            return dict(row)

    def set_welcome(self, chat_id: int, text: str) -> None:
        self.ensure_group(chat_id)
        with self._lock, self._connect() as conn:
            conn.execute(
                "UPDATE group_settings SET welcome_text = ? WHERE chat_id = ?",
                (text, chat_id),
            )
            conn.commit()

    def toggle_welcome(self, chat_id: int, enabled: bool) -> None:
        self.ensure_group(chat_id)
        with self._lock, self._connect() as conn:
            conn.execute(
                "UPDATE group_settings SET welcome_enabled = ? WHERE chat_id = ?",
                (1 if enabled else 0, chat_id),
            )
            conn.commit()

    def set_rules(self, chat_id: int, text: str) -> None:
        self.ensure_group(chat_id)
        with self._lock, self._connect() as conn:
            conn.execute(
                "UPDATE group_settings SET rules_text = ? WHERE chat_id = ?",
                (text, chat_id),
            )
            conn.commit()

    def upsert_member(
        self,
        chat_id: int,
        user_id: int,
        username: Optional[str],
        full_name: str,
        is_bot: bool = False,
        is_active: bool = True,
        increment_msg: bool = False,
    ) -> None:
        now = self._now()
        clean_username = username.lower().lstrip("@") if username else None
        with self._lock, self._connect() as conn:
            existing = conn.execute(
                "SELECT msg_count FROM members WHERE chat_id = ? AND user_id = ?",
                (chat_id, user_id),
            ).fetchone()

            if existing is None:
                conn.execute(
                    """
                    INSERT INTO members (
                        chat_id, user_id, username, full_name, is_bot,
                        is_active, msg_count, warns, first_seen, last_seen
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
                    """,
                    (
                        chat_id,
                        user_id,
                        clean_username,
                        full_name,
                        1 if is_bot else 0,
                        1 if is_active else 0,
                        1 if increment_msg else 0,
                        now,
                        now,
                    ),
                )
            else:
                new_count = existing["msg_count"] + (1 if increment_msg else 0)
                conn.execute(
                    """
                    UPDATE members
                    SET username = ?, full_name = ?, is_bot = ?,
                        is_active = ?, msg_count = ?, last_seen = ?
                    WHERE chat_id = ? AND user_id = ?
                    """,
                    (
                        clean_username,
                        full_name,
                        1 if is_bot else 0,
                        1 if is_active else 0,
                        new_count,
                        now,
                        chat_id,
                        user_id,
                    ),
                )
            conn.commit()

    def mark_member_inactive(self, chat_id: int, user_id: int) -> None:
        with self._lock, self._connect() as conn:
            conn.execute(
                "UPDATE members SET is_active = 0, last_seen = ? WHERE chat_id = ? AND user_id = ?",
                (self._now(), chat_id, user_id),
            )
            conn.commit()

    def get_active_members(self, chat_id: int) -> list[dict]:
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                """
                SELECT user_id, username, full_name
                FROM members
                WHERE chat_id = ? AND is_active = 1 AND is_bot = 0
                ORDER BY last_seen DESC
                """,
                (chat_id,),
            ).fetchall()
            return [dict(r) for r in rows]

    def get_member(self, chat_id: int, user_id: int) -> Optional[dict]:
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM members WHERE chat_id = ? AND user_id = ?",
                (chat_id, user_id),
            ).fetchone()
            return dict(row) if row else None

    def find_member_by_username(self, chat_id: int, username: str) -> Optional[dict]:
        clean = username.lower().lstrip("@")
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM members WHERE chat_id = ? AND username = ?",
                (chat_id, clean),
            ).fetchone()
            return dict(row) if row else None

    def find_member_by_username_global(self, username: str) -> Optional[dict]:
        clean = username.lower().lstrip("@")
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM members WHERE username = ? ORDER BY last_seen DESC LIMIT 1",
                (clean,),
            ).fetchone()
            return dict(row) if row else None

    def add_warn(self, chat_id: int, user_id: int) -> int:
        with self._lock, self._connect() as conn:
            conn.execute(
                "UPDATE members SET warns = warns + 1 WHERE chat_id = ? AND user_id = ?",
                (chat_id, user_id),
            )
            conn.commit()
            row = conn.execute(
                "SELECT warns FROM members WHERE chat_id = ? AND user_id = ?",
                (chat_id, user_id),
            ).fetchone()
            return row["warns"] if row else 1

    def reset_warns(self, chat_id: int, user_id: int) -> None:
        with self._lock, self._connect() as conn:
            conn.execute(
                "UPDATE members SET warns = 0 WHERE chat_id = ? AND user_id = ?",
                (chat_id, user_id),
            )
            conn.commit()

    def has_ca_notice_sent(self, chat_id: int, user_id: int) -> bool:
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT 1 FROM ca_notice_log WHERE chat_id = ? AND user_id = ?",
                (chat_id, user_id),
            ).fetchone()
            return bool(row)

    def mark_ca_notice_sent(self, chat_id: int, user_id: int) -> None:
        with self._lock, self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO ca_notice_log (chat_id, user_id, last_notified_at) VALUES (?, ?, ?)",
                (chat_id, user_id, self._now()),
            )
            conn.commit()

    def mark_bot_ca_message(self, chat_id: int, message_id: int) -> None:
        with self._lock, self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO bot_ca_messages (chat_id, message_id, created_at) VALUES (?, ?, ?)",
                (chat_id, message_id, self._now()),
            )
            conn.commit()

    def is_bot_ca_message(self, chat_id: int, message_id: int) -> bool:
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT 1 FROM bot_ca_messages WHERE chat_id = ? AND message_id = ?",
                (chat_id, message_id),
            ).fetchone()
            return bool(row)
`,
  },
  {
    id: 'requirements.txt',
    filename: 'requirements.txt',
    language: 'text',
    description: 'Python dependencies for python-telegram-bot, Google GenAI SDK, async HTTPX, and dotenv.',
    content: `python-telegram-bot>=21.6,<23.0
google-genai>=1.0.0
httpx>=0.27.0
python-dotenv>=1.0.1
# Optional (only required if enabling OWNER_SESSION_STRING to /demote or /promote Owner-promoted admins):
# telethon>=1.36.0
`,
  },
  {
    id: '.env.example',
    filename: '.env.example',
    language: 'dotenv',
    description: 'Environment template for BotFather token, Gemini API key, model name, and SQLite path.',
    content: `TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
GEMINI_API_KEY=your_google_gemini_api_key_here
GEMINI_MODEL=gemini-4-hydrogen
DB_PATH=bot_data.db

# Optional Owner MTProto mode (lets /demote and /promote modify ANY old/Owner-promoted admin):
# TELEGRAM_API_ID=12345678
# TELEGRAM_API_HASH=your_my_telegram_org_api_hash
# OWNER_SESSION_STRING=your_telethon_owner_string_session
`,
  },
  {
    id: 'Dockerfile',
    filename: 'Dockerfile',
    language: 'dockerfile',
    description: '24/7 Docker image for deploying the standalone Python bot to Koyeb, Render, Fly.io, Railway, or any VPS.',
    content: `FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY bot.py database.py ./

CMD ["python", "bot.py"]
`,
  },
  {
    id: 'render.yaml',
    filename: 'render.yaml',
    language: 'yaml',
    description: 'Render Blueprint manifest for 1-click 24/7 background deployment with persistent SQLite disk.',
    content: `services:
  - type: web
    name: ca-rose-bot
    runtime: python
    plan: free
    buildCommand: pip install -r requirements.txt
    startCommand: python bot.py
    healthCheckPath: /healthz
    envVars:
      - key: TELEGRAM_BOT_TOKEN
        sync: false
      - key: GEMINI_API_KEY
        sync: false
      - key: GEMINI_MODEL
        value: gemini-4-hydrogen
      - key: DB_PATH
        value: bot_data.db
`,
  },
  {
    id: 'Procfile',
    filename: 'Procfile',
    language: 'text',
    description: 'Process definition for Railway, Heroku, and Dokku 24/7 worker runners.',
    content: `worker: python bot.py
`,
  },
];

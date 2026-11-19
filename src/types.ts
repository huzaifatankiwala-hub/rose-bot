export type MemberRole = 'owner' | 'administrator' | 'member';

export interface GroupSettings {
  chat_id: number;
  chat_title: string;
  welcome_enabled: boolean;
  welcome_text: string;
  rules_text: string;
  max_warns: number;
  pinned_message_id: number | null;
}

export interface GroupMember {
  chat_id: number;
  user_id: number;
  username: string | null;
  full_name: string;
  role: MemberRole;
  is_bot: boolean;
  is_active: boolean;
  is_muted: boolean;
  muted_until: string | null;
  msg_count: number;
  warns: number;
  first_seen: string;
  last_seen: string;
  avatar_url: string | null;
}

export interface ChatMessage {
  id: number;
  chat_id: number;
  sender_id: number;
  sender_name: string;
  sender_username: string | null;
  sender_role: MemberRole;
  is_bot: boolean;
  text: string;
  reply_to_id: number | null;
  reply_to_snippet: string | null;
  audio_name: string | null;
  audio_mime: string | null;
  message_type: 'chat' | 'command' | 'bot_reply' | 'system' | 'weather' | 'tagall' | 'info' | 'ca_ai';
  created_at: string;
}

export interface WeatherResult {
  place: string;
  condition: string;
  weatherCode: number;
  temperatureC: number;
  apparentTemperatureC: number;
  minTempC: number;
  maxTempC: number;
  humidityPct: number;
  windKmh: number;
}

export interface OwnerOverrideStatus {
  configured: boolean;
  connected: boolean;
  accountLabel: string | null;
  userId: string | null;
  connectedAt?: string | null;
  freshCooldownRemaining?: string | null;
  lastError: string | null;
  pendingLogin: {
    active: boolean;
    phoneMasked: string | null;
    awaitingPassword: boolean;
  };
}

export interface TelegramBridgeStatus {
  configured: boolean;
  running: boolean;
  mode: 'polling' | 'webhook' | 'stopped';
  webhookUrl: string | null;
  botUsername: string;
  botFirstName: string;
  canReadAllGroupMessages: boolean | null;
  updatesProcessed: number;
  lastEvent: string | null;
  lastError: string | null;
  ownerOverride?: OwnerOverrideStatus;
}

export interface AppStateResponse {
  settings: GroupSettings;
  members: GroupMember[];
  messages: ChatMessage[];
  pinnedMessage: ChatMessage | null;
  telegram: TelegramBridgeStatus;
}

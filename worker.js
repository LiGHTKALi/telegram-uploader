import { DurableObject } from "cloudflare:workers";

const CONFIG = Object.freeze({
  BOT_TOKEN: "8426761408:AAEkzTm3TSmhJvsGWKCzG3XnMNHWgpO7U7s",
  WEBHOOK_SECRET: "UploaderWebhook_2026_9F4k7P2m8Qx3Vt6Z",
  FREE_DOWNLOADS: 2,
  MAX_SINGLE_UPLOADS: 10,
  MAX_MULTI_UPLOADS: 100,
  MAX_REQUIRED_CHANNELS: 20,
  MAX_ADMINS: 100,
  MAX_BROADCAST_BATCH: 20,
  BROADCAST_RETRY_MS: 5_000,
  INPUT_TIMEOUT_MS: 15 * 60 * 1000,
  TELEGRAM_TIMEOUT_MS: 30_000,
  TELEGRAM_SAFE_TEXT: 3800,
  MAX_SUFFIX_LENGTH: 1000,
  MAX_WELCOME_TEXT: 4000,
  CALLBACK_LIMIT: 64
});

function envValue(env, key, fallback = "") {
  return String(env?.[key] ?? fallback).trim();
}

function getOwnerId(env) {
  const value = envValue(env, "OWNER_ID");
  return value && /^-?\d+$/.test(value) ? value : "";
}

function getBotToken(env) {
  return envValue(env, "BOT_TOKEN", CONFIG.BOT_TOKEN) || CONFIG.BOT_TOKEN;
}

function apiBase(env) {
  const token = getBotToken(env);
  if (!token) throw new Error("BOT_TOKEN is not configured.");
  return `https://api.telegram.org/bot${token}`;
}

function now() {
  return Date.now();
}

function unixDay(timestamp = now()) {
  return Math.floor(Number(timestamp) / 86_400_000);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shortText(value, max = 120) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function normalizeUsername(value) {
  return String(value || "").trim().replace(/^@+/, "").toLowerCase();
}

function callbackData(value) {
  const data = String(value || "");
  if (new TextEncoder().encode(data).length > CONFIG.CALLBACK_LIMIT) throw new Error("Callback data too long.");
  return data;
}

function btn(text, data, style) {
  const item = { text, callback_data: callbackData(data) };
  if (style) item.style = style;
  return item;
}

function urlBtn(text, url, style) {
  const item = { text, url };
  if (style) item.style = style;
  return item;
}

function parseCommand(text) {
  const input = String(text || "").trim();
  if (!input.startsWith("/")) return null;
  const index = input.indexOf(" ");
  const raw = index === -1 ? input : input.slice(0, index);
  return {
    command: raw.split("@")[0].toLowerCase(),
    args: index === -1 ? "" : input.slice(index + 1).trim()
  };
}

function isUploadMessage(message) {
  return Boolean(
    message?.document ||
    message?.photo ||
    message?.video ||
    message?.animation ||
    message?.audio ||
    message?.voice ||
    message?.video_note ||
    message?.sticker
  );
}

function messageKind(message) {
  if (message?.document) return "document";
  if (message?.photo) return "photo";
  if (message?.video) return "video";
  if (message?.animation) return "animation";
  if (message?.audio) return "audio";
  if (message?.voice) return "voice";
  if (message?.video_note) return "video_note";
  if (message?.sticker) return "sticker";
  return "message";
}

function messageLabel(message) {
  const kind = messageKind(message);
  if (kind === "document") return shortText(message.document?.file_name || "Document");
  if (kind === "photo") return "Photo";
  if (kind === "video") return shortText(message.video?.file_name || "Video");
  if (kind === "animation") return shortText(message.animation?.file_name || "Animation");
  if (kind === "audio") return shortText(message.audio?.file_name || message.audio?.title || "Audio");
  if (kind === "voice") return "Voice";
  if (kind === "video_note") return "Video note";
  if (kind === "sticker") return "Sticker";
  return "Message";
}

function isStorageUnavailableError(error) {
  const text = String(error?.message || error || "").toLowerCase();
  return /message to copy not found|message not found|message_id_invalid|chat not found|have no access to the message|bad request: message to copy/.test(text);
}

async function telegram(env, method, body = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.TELEGRAM_TIMEOUT_MS);
  try {
    const response = await fetch(`${apiBase(env)}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok || !payload?.ok) {
      const error = new Error(payload?.description || `Telegram HTTP ${response.status}`);
      error.status = Number(payload?.error_code || response.status);
      error.parameters = payload?.parameters || null;
      throw error;
    }
    return payload.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function safeTelegram(env, method, body = {}) {
  try {
    return { ok: true, result: await telegram(env, method, body) };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

function formatRemaining(ms) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || !parts.length) parts.push(`${minutes}m`);
  return parts.join(" ");
}

function adminRoleLabel(role) {
  return role === "full" ? "👑 Full Admin" : "📤 Upload Admin";
}

function isPrivilegedRole(role) {
  return role === "full";
}

export class Uploader extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  ensureColumn(table, column, definition) {
    const columns = this.ctx.storage.sql.exec(`PRAGMA table_info(${table})`).toArray();
    if (!columns.some(row => String(row.name) === column)) this.ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  migrate() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        username TEXT NOT NULL DEFAULT '',
        first_name TEXT NOT NULL DEFAULT '',
        last_name TEXT NOT NULL DEFAULT '',
        joined_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        downloads_used INTEGER NOT NULL DEFAULT 0,
        referral_downloads INTEGER NOT NULL DEFAULT 0,
        premium_until INTEGER NOT NULL DEFAULT 0,
        premium_permanent INTEGER NOT NULL DEFAULT 0,
        referral_invited_by TEXT,
        referral_qualified INTEGER NOT NULL DEFAULT 0,
        blocked INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS admins (
        user_id TEXT PRIMARY KEY,
        username TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL CHECK(role IN ('upload','full')),
        created_at INTEGER NOT NULL,
        created_by TEXT NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL DEFAULT '',
        username TEXT NOT NULL DEFAULT '',
        join_url TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT NOT NULL UNIQUE,
        owner_id TEXT NOT NULL,
        storage_message_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        caption TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS files_owner ON files(owner_id, id DESC)`);
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS files_token ON files(token)`);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS upload_sets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('single','multi')),
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'open'
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS upload_set_items (
        set_id INTEGER NOT NULL,
        file_id INTEGER NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY(set_id, position),
        UNIQUE(set_id, file_id)
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS referrals (
        referrer_id TEXT NOT NULL,
        referred_id TEXT NOT NULL UNIQUE,
        qualified INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        qualified_at INTEGER,
        PRIMARY KEY(referrer_id, referred_id)
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        ticket_day INTEGER NOT NULL,
        channel_message_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        premium_until INTEGER,
        premium_label TEXT
      )
    `);
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS tickets_user_day ON tickets(user_id, ticket_day)`);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS broadcasts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        storage_message_id INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_user_id TEXT NOT NULL DEFAULT '',
        sent_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'running',
        last_error TEXT NOT NULL DEFAULT ''
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        user_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        data_json TEXT NOT NULL DEFAULT '{}',
        expires_at INTEGER NOT NULL
      )
    `);
    this.ensureColumn("users", "request_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("users", "upload_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("users", "download_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("users", "downloads_reserved", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("users", "last_upload_at", "INTEGER");
    this.ensureColumn("users", "last_download_at", "INTEGER");
    this.ensureColumn("admins", "username", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("channels", "username", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("channels", "join_url", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("channels", "active", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("files", "caption", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("files", "deleted", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("upload_sets", "status", "TEXT NOT NULL DEFAULT 'open'");
    this.ensureColumn("referrals", "qualified", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("referrals", "qualified_at", "INTEGER");
    this.ensureColumn("tickets", "status", "TEXT NOT NULL DEFAULT 'pending'");
    this.ensureColumn("tickets", "premium_until", "INTEGER");
    this.ensureColumn("tickets", "premium_label", "TEXT");
    this.ensureColumn("broadcasts", "last_user_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("broadcasts", "sent_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("broadcasts", "failed_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("broadcasts", "status", "TEXT NOT NULL DEFAULT 'running'");
    this.ensureColumn("broadcasts", "last_error", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("sessions", "data_json", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("sessions", "expires_at", "INTEGER NOT NULL DEFAULT 0");
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        bot_username TEXT NOT NULL DEFAULT '',
        storage_chat_id TEXT NOT NULL DEFAULT '',
        storage_title TEXT NOT NULL DEFAULT '',
        ticket_chat_id TEXT NOT NULL DEFAULT '',
        ticket_title TEXT NOT NULL DEFAULT '',
        welcome_message_id INTEGER,
        welcome_kind TEXT NOT NULL DEFAULT '',
        suffix TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.ensureColumn("settings", "bot_username", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("settings", "storage_chat_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("settings", "storage_title", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("settings", "ticket_chat_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("settings", "ticket_title", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("settings", "welcome_message_id", "INTEGER");
    this.ensureColumn("settings", "welcome_kind", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("settings", "suffix", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("settings", "created_at", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("settings", "updated_at", "INTEGER NOT NULL DEFAULT 0");
    this.ctx.storage.sql.exec(`
      INSERT OR IGNORE INTO settings(id, created_at, updated_at) VALUES(1, ?, ?)
    `, now(), now());
    this.ctx.storage.sql.exec(`
      UPDATE users SET downloads_reserved = 0 WHERE downloads_reserved IS NULL OR downloads_reserved < 0
    `);
    this.ctx.storage.sql.exec(`
      DELETE FROM tickets
      WHERE id NOT IN (SELECT MIN(id) FROM tickets GROUP BY user_id, ticket_day)
    `);
    this.ctx.storage.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS tickets_user_day_unique ON tickets(user_id, ticket_day)`);
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS users_last_seen ON users(last_seen_at DESC)`);
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS users_requests ON users(request_count DESC)`);
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS files_deleted_id ON files(deleted, id DESC)`);
    this.ctx.storage.sql.exec(`INSERT INTO meta(key, value) VALUES('schema_version', '3') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  }

  first(sql, ...params) {
    return this.ctx.storage.sql.exec(sql, ...params).toArray()[0] || null;
  }

  all(sql, ...params) {
    return this.ctx.storage.sql.exec(sql, ...params).toArray();
  }

  execInsertId(sql, ...params) {
    this.ctx.storage.sql.exec(sql, ...params);
    return Number(this.first(`SELECT last_insert_rowid() AS id`)?.id || 0);
  }

  setBotUsername(username) {
    this.updateSettings({ bot_username: String(username || "").trim().toLowerCase() });
  }

  getSettings() {
    const row = this.first(`SELECT * FROM settings WHERE id = 1`);
    if (!row) throw new Error("Settings initialization failed.");
    return row;
  }

  updateSettings(fields) {
    const allowed = new Set([
      "bot_username",
      "storage_chat_id",
      "storage_title",
      "ticket_chat_id",
      "ticket_title",
      "welcome_message_id",
      "welcome_kind",
      "suffix"
    ]);
    const keys = Object.keys(fields).filter(key => allowed.has(key));
    if (!keys.length) return;
    const values = keys.map(key => fields[key]);
    this.ctx.storage.sql.exec(
      `UPDATE settings SET ${keys.map(key => `${key} = ?`).join(", ")}, updated_at = ? WHERE id = 1`,
      ...values,
      now()
    );
  }

  roleFor(userId) {
    const ownerId = getOwnerId(this.env);
    const id = String(userId || "");
    if (ownerId && id === ownerId) return "owner";
    const row = this.first(`SELECT role FROM admins WHERE user_id = ?`, id);
    return row ? String(row.role) : "user";
  }

  canUpload(userId) {
    const role = this.roleFor(userId);
    return role === "owner" || role === "full" || role === "upload";
  }

  canManage(userId) {
    const role = this.roleFor(userId);
    return role === "owner" || role === "full";
  }

  canManageAdmins(userId) {
    return this.roleFor(userId) === "owner";
  }

  canApprovePremium(userId) {
    return this.roleFor(userId) === "owner" || this.roleFor(userId) === "full";
  }

  upsertUser(user) {
    const userId = String(user?.id || "");
    if (!userId) return;
    this.ctx.storage.sql.exec(`
      INSERT INTO users(user_id, username, first_name, last_name, joined_at, last_seen_at)
      VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        last_seen_at = excluded.last_seen_at,
        blocked = 0
    `,
      userId,
      String(user?.username || ""),
      String(user?.first_name || ""),
      String(user?.last_name || ""),
      now(),
      now()
    );
  }

  recordRequest(userId) {
    this.ctx.storage.sql.exec(`UPDATE users SET request_count = request_count + 1, last_seen_at = ? WHERE user_id = ?`, now(), String(userId));
  }

  session(userId) {
    const row = this.first(`SELECT mode, data_json, expires_at FROM sessions WHERE user_id = ?`, String(userId));
    if (!row) return null;
    if (Number(row.expires_at) < now()) {
      this.clearSession(userId);
      return null;
    }
    let data = {};
    try {
      data = JSON.parse(row.data_json || "{}");
    } catch {
      data = {};
    }
    return { mode: String(row.mode), data };
  }

  setSession(userId, mode, data = {}, ttl = CONFIG.INPUT_TIMEOUT_MS) {
    this.ctx.storage.sql.exec(`
      INSERT INTO sessions(user_id, mode, data_json, expires_at)
      VALUES(?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET mode = excluded.mode, data_json = excluded.data_json, expires_at = excluded.expires_at
    `, String(userId), String(mode), JSON.stringify(data), now() + ttl);
  }

  clearSession(userId) {
    this.ctx.storage.sql.exec(`DELETE FROM sessions WHERE user_id = ?`, String(userId));
  }

  requireRole(userId, required) {
    const role = this.roleFor(userId);
    const rank = { user: 0, upload: 1, full: 2, owner: 3 };
    if ((rank[role] || 0) < (rank[required] || 0)) throw new Error("Access denied.");
    return role;
  }

  async getBotInfo() {
    const info = await telegram(this.env, "getMe");
    if (info?.username) this.updateSettings({ bot_username: String(info.username).toLowerCase() });
    return info;
  }

  async verifyWebhook(request) {
    const expected = envValue(this.env, "WEBHOOK_SECRET", CONFIG.WEBHOOK_SECRET) || CONFIG.WEBHOOK_SECRET;
    return String(request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "") === expected;
  }

  async setChannel(reference, kind) {
    const value = String(reference || "").trim();
    if (!value) throw new Error("Channel identifier is required.");
    const chat = await telegram(this.env, "getChat", { chat_id: value });
    if (!chat?.id) throw new Error("Channel not found.");
    if (chat.type !== "channel") throw new Error("Target must be a Telegram channel.");
    const me = await telegram(this.env, "getMe");
    const botMember = await telegram(this.env, "getChatMember", { chat_id: chat.id, user_id: me.id });
    const botStatus = String(botMember?.status || "");
    if (!["administrator", "creator"].includes(botStatus)) throw new Error("Bot must be administrator in that channel.");
    if ((kind === "storage" || kind === "ticket") && botStatus !== "creator" && botMember?.can_post_messages === false) throw new Error("Bot does not have permission to post in this channel.");
    if (kind === "storage" && botStatus !== "creator" && botMember?.can_delete_messages === false) throw new Error("Bot does not have permission to delete stored messages in this channel.");
    if (kind === "required" && !chat.username && botStatus !== "creator" && botMember?.can_invite_users === false) throw new Error("Bot needs permission to invite users to this private channel.");
    if (kind === "required") {
      const existing = this.first(`SELECT id FROM channels WHERE chat_id = ?`, String(chat.id));
      if (!existing) {
        const count = Number(this.first(`SELECT COUNT(*) AS count FROM channels WHERE active = 1`)?.count || 0);
        if (count >= CONFIG.MAX_REQUIRED_CHANNELS) throw new Error(`Maximum ${CONFIG.MAX_REQUIRED_CHANNELS} required channels allowed.`);
      }
      let joinUrl = chat.username ? `https://t.me/${chat.username}` : "";
      if (!joinUrl) {
        const invite = await safeTelegram(this.env, "createChatInviteLink", { chat_id: chat.id });
        joinUrl = invite.ok ? String(invite.result?.invite_link || "") : "";
      }
      if (!joinUrl) throw new Error("Could not obtain a join link for this channel.");
      this.ctx.storage.sql.exec(`
        INSERT INTO channels(chat_id, title, username, join_url, active, created_at)
        VALUES(?, ?, ?, ?, 1, ?)
        ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title, username = excluded.username, join_url = excluded.join_url, active = 1
      `, String(chat.id), String(chat.title || ""), chat.username ? `@${chat.username}` : "", joinUrl, now());
    }
    if (kind === "storage") this.updateSettings({ storage_chat_id: String(chat.id), storage_title: String(chat.title || chat.username || chat.id) });
    if (kind === "ticket") this.updateSettings({ ticket_chat_id: String(chat.id), ticket_title: String(chat.title || chat.username || chat.id) });
    return chat;
  }
  async channelsSatisfied(userId) {
    const channels = this.all(`SELECT * FROM channels WHERE active = 1 ORDER BY id ASC`);
    if (!channels.length) return { ok: true, missing: [] };
    const missing = [];
    for (const channel of channels) {
      try {
        const member = await telegram(this.env, "getChatMember", { chat_id: channel.chat_id, user_id: String(userId) });
        if (!["member", "administrator", "creator"].includes(String(member?.status))) missing.push(channel);
      } catch (error) {
        missing.push({ ...channel, error: String(error?.message || error) });
      }
    }
    return { ok: missing.length === 0, missing };
  }

  async qualifyReferral(userId, membership = null) {
    const user = this.first(`SELECT referral_invited_by, referral_qualified FROM users WHERE user_id = ?`, String(userId));
    if (!user?.referral_invited_by || Number(user.referral_qualified)) return false;
    const channels = membership || await this.channelsSatisfied(userId);
    if (!channels.ok) return false;
    const changed = this.ctx.storage.sql.exec(`
      UPDATE users SET referral_qualified = 1 WHERE user_id = ? AND referral_qualified = 0
    `, String(userId));
    if (!Number(changed.changes || 0)) return false;
    this.ctx.storage.sql.exec(`
      INSERT INTO referrals(referrer_id, referred_id, qualified, created_at, qualified_at)
      VALUES(?, ?, 1, ?, ?)
      ON CONFLICT(referred_id) DO UPDATE SET qualified = 1, qualified_at = excluded.qualified_at
    `, String(user.referral_invited_by), String(userId), now(), now());
    this.ctx.storage.sql.exec(`
      UPDATE users SET referral_downloads = referral_downloads + 1 WHERE user_id = ?
    `, String(user.referral_invited_by));
    await safeTelegram(this.env, "sendMessage", {
      chat_id: String(user.referral_invited_by),
      text: "🎉 یک زیرمجموعه موفق شد. یک دانلود به سهمیه Referral شما اضافه شد.",
      reply_markup: this.userKeyboard(String(user.referral_invited_by))
    });
    return true;
  }

  async gate(userId, notify = true) {
    const result = await this.channelsSatisfied(userId);
    await this.qualifyReferral(userId, result);
    if (result.ok) return true;
    if (notify) await this.sendMembershipGate(userId, result.missing);
    return false;
  }

  async sendMembershipGate(userId, missing = null) {
    const channels = missing || (await this.channelsSatisfied(userId)).missing;
    if (!channels.length) return this.sendUser(userId, "✅ عضویت کامل است.");
    const rows = channels.map(channel => {
      const label = `📢 ${shortText(channel.title || channel.username || channel.chat_id, 35)}`;
      return [urlBtn(label, channel.join_url || "", "primary")];
    });
    rows.push([btn("🔄 بررسی عضویت", "gate:check", "success")]);
    return this.sendUser(userId, "🔒 برای دریافت فایل باید ابتدا در همه کانال‌های زیر عضو شوی، سپس روی «بررسی عضویت» بزن. عضویت هنگام هر دانلود دوباره بررسی می‌شود.", { inline_keyboard: rows });
  }

  isPremium(userId) {
    const user = this.first(`SELECT premium_until, premium_permanent FROM users WHERE user_id = ?`, String(userId));
    if (!user) return false;
    return Number(user.premium_permanent) === 1 || Number(user.premium_until || 0) > now();
  }

  availableDownloads(userId) {
    const user = this.first(`SELECT downloads_used, referral_downloads, downloads_reserved FROM users WHERE user_id = ?`, String(userId));
    if (!user) return 0;
    const freeLeft = Math.max(0, CONFIG.FREE_DOWNLOADS - Number(user.downloads_used || 0));
    const referral = Math.max(0, Number(user.referral_downloads || 0));
    return Math.max(0, freeLeft + referral - Number(user.downloads_reserved || 0));
  }

  reserveDownload(userId) {
    const id = String(userId);
    const free = this.ctx.storage.sql.exec(`
      UPDATE users
      SET downloads_used = downloads_used + 1, downloads_reserved = downloads_reserved + 1
      WHERE user_id = ? AND downloads_used < ?
    `, id, CONFIG.FREE_DOWNLOADS);
    if (Number(free.changes || 0)) return "free";
    const referral = this.ctx.storage.sql.exec(`
      UPDATE users
      SET referral_downloads = referral_downloads - 1, downloads_reserved = downloads_reserved + 1
      WHERE user_id = ? AND referral_downloads > 0
    `, id);
    if (Number(referral.changes || 0)) return "referral";
    throw new Error("Download quota exceeded.");
  }

  commitDownload(userId) {
    this.ctx.storage.sql.exec(`UPDATE users SET downloads_reserved = CASE WHEN downloads_reserved > 0 THEN downloads_reserved - 1 ELSE 0 END, download_count = download_count + 1, last_download_at = ? WHERE user_id = ?`, now(), String(userId));
  }

  refundDownload(userId, kind) {
    const id = String(userId);
    if (kind === "free") this.ctx.storage.sql.exec(`UPDATE users SET downloads_used = CASE WHEN downloads_used > 0 THEN downloads_used - 1 ELSE 0 END, downloads_reserved = CASE WHEN downloads_reserved > 0 THEN downloads_reserved - 1 ELSE 0 END WHERE user_id = ?`, id);
    else if (kind === "referral") this.ctx.storage.sql.exec(`UPDATE users SET referral_downloads = referral_downloads + 1, downloads_reserved = CASE WHEN downloads_reserved > 0 THEN downloads_reserved - 1 ELSE 0 END WHERE user_id = ?`, id);
    else this.ctx.storage.sql.exec(`UPDATE users SET downloads_reserved = CASE WHEN downloads_reserved > 0 THEN downloads_reserved - 1 ELSE 0 END WHERE user_id = ?`, id);
  }
  refLink(userId) {
    const settings = this.getSettings();
    const username = String(settings.bot_username || "");
    return username ? `https://t.me/${username}?start=ref_${encodeURIComponent(String(userId))}` : "";
  }

  fileLink(token) {
    const username = String(this.getSettings().bot_username || "");
    return username ? `https://t.me/${username}?start=file_${encodeURIComponent(String(token))}` : "";
  }

  async storeMessage(message, ownerId) {
    const settings = this.getSettings();
    if (!settings.storage_chat_id) throw new Error("Storage channel is not configured.");
    if (!isUploadMessage(message)) throw new Error("این پیام فایل قابل آپلود نیست.");
    const copied = await telegram(this.env, "copyMessage", {
      chat_id: settings.storage_chat_id,
      from_chat_id: String(message.chat.id),
      message_id: Number(message.message_id),
      disable_notification: true,
      protect_content: false
    });
    const token = Array.from(crypto.getRandomValues(new Uint8Array(12)), byte => byte.toString(16).padStart(2, "0")).join("");
    const caption = String(message.caption || "").slice(0, 1024);
    const label = messageLabel(message);
    try {
      const id = this.execInsertId(`
        INSERT INTO files(token, owner_id, storage_message_id, kind, label, caption, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
      `, token, String(ownerId), Number(copied?.message_id || 0), messageKind(message), label, caption, now());
      this.ctx.storage.sql.exec(`UPDATE users SET upload_count = upload_count + 1, last_upload_at = ? WHERE user_id = ?`, now(), String(ownerId));
      return this.first(`SELECT * FROM files WHERE id = ?`, id);
    } catch (error) {
      await safeTelegram(this.env, "deleteMessage", { chat_id: settings.storage_chat_id, message_id: Number(copied?.message_id || 0) });
      throw error;
    }
  }
  newUploadSet(userId, mode) {
    return this.execInsertId(`INSERT INTO upload_sets(owner_id, mode, created_at) VALUES(?, ?, ?)`, String(userId), String(mode), now());
  }

  addSetItem(setId, fileId) {
    const row = this.first(`SELECT COALESCE(MAX(position), 0) AS position FROM upload_set_items WHERE set_id = ?`, Number(setId));
    const position = Number(row?.position || 0) + 1;
    this.ctx.storage.sql.exec(`INSERT INTO upload_set_items(set_id, file_id, position) VALUES(?, ?, ?)`, Number(setId), Number(fileId), position);
    return position;
  }

  setItems(setId) {
    return this.all(`
      SELECT f.*, s.position
      FROM upload_set_items s
      JOIN files f ON f.id = s.file_id
      WHERE s.set_id = ? AND f.deleted = 0
      ORDER BY s.position ASC
    `, Number(setId));
  }

  closeSet(setId) {
    this.ctx.storage.sql.exec(`UPDATE upload_sets SET status = 'closed' WHERE id = ?`, Number(setId));
  }

  async copyStoredFile(userId, file) {
    const settings = this.getSettings();
    if (!settings.storage_chat_id) throw new Error("Storage channel is not configured.");
    try {
      return await telegram(this.env, "copyMessage", {
        chat_id: String(userId),
        from_chat_id: settings.storage_chat_id,
        message_id: Number(file.storage_message_id),
        protect_content: false
      });
    } catch (error) {
      if (isStorageUnavailableError(error)) this.ctx.storage.sql.exec(`UPDATE files SET deleted = 1 WHERE id = ?`, Number(file.id));
      throw new Error(`Stored file is unavailable: ${String(error?.message || error)}`);
    }
  }

  async deliverFile(userId, file) {
    if (!file || Number(file.deleted)) throw new Error("This file is unavailable.");
    if (!(await this.gate(userId, true))) return false;
    const premium = this.isPremium(userId);
    let reservation = null;
    if (!premium) reservation = this.reserveDownload(userId);
    try {
      await this.copyStoredFile(userId, file);
      if (!premium) this.commitDownload(userId);
      const suffix = this.getSettings().suffix;
      if (suffix) await this.sendUser(userId, suffix);
      return true;
    } catch (error) {
      if (!premium) this.refundDownload(userId, reservation);
      throw error;
    }
  }

  async deliverSet(userId, setId) {
    const items = this.setItems(setId);
    if (!items.length) throw new Error("Upload set is empty.");
    if (!(await this.gate(userId, true))) return false;
    const premium = this.isPremium(userId);
    if (!premium && this.availableDownloads(userId) < items.length) {
      await this.sendQuotaPage(userId);
      return false;
    }
    for (const item of items) {
      let reservation = null;
      if (!premium) reservation = this.reserveDownload(userId);
      try {
        await this.copyStoredFile(userId, item);
        if (!premium) this.commitDownload(userId);
        const suffix = this.getSettings().suffix;
        if (suffix) await this.sendUser(userId, suffix);
      } catch (error) {
        if (!premium) this.refundDownload(userId, reservation);
        throw error;
      }
    }
    return true;
  }
  async sendQuotaPage(userId) {
    const link = this.refLink(userId);
    const count = this.first(`SELECT COUNT(*) AS count FROM referrals WHERE referrer_id = ? AND qualified = 1`, String(userId));
    const active = Number(count?.count || 0);
    const text = [
      "🎁 سهمیه رایگان شما تمام شد.",
      "",
      `دانلود آزاد باقی‌مانده: 0`,
      `زیرمجموعه موفق: ${active}`,
      "هر زیرمجموعه موفق ۱ دانلود اضافه می‌کند.",
      "",
      link ? "لینک دعوت اختصاصی شما:" : "لینک دعوت هنوز آماده نشده است.",
      link || ""
    ].join("\n");
    return this.sendUser(userId, text, {
      inline_keyboard: [
        link ? [btn("🔗 لینک دعوت من", `ref:copy:${String(userId).slice(-30)}`, "primary")] : [],
        [btn("🔄 بررسی عضویت", "gate:check", "success"), btn("💎 خرید Premium", "premium:buy", "primary")]
      ].filter(row => row.length)
    });
  }

  async sendWelcome(userId) {
    const settings = this.getSettings();
    if (!settings.welcome_message_id || !settings.storage_chat_id) return this.sendUser(userId, "👋 خوش آمدی! برای شروع از منوی زیر استفاده کن.", this.userKeyboard(userId));
    try {
      await telegram(this.env, "copyMessage", {
        chat_id: String(userId),
        from_chat_id: settings.storage_chat_id,
        message_id: Number(settings.welcome_message_id),
        protect_content: false
      });
      return this.sendUser(userId, "", this.userKeyboard(userId), true);
    } catch {
      return this.sendUser(userId, "👋 خوش آمدی! پیام خوش‌آمدگویی فعلاً قابل ارسال نیست.", this.userKeyboard(userId));
    }
  }

  userKeyboard(userId) {
    const role = this.roleFor(userId);
    const rows = [
      [btn("🎁 سهمیه و دعوت", "user:quota", "primary"), btn("💎 Premium", "premium:buy", "primary")],
      [btn("🔄 بررسی عضویت", "gate:check", "success")]
    ];
    if (role === "upload" || role === "full" || role === "owner") rows.unshift([btn("📥 تک‌فایل", "upload:single", "success"), btn("📚 چندتایی", "upload:multi", "success")]);
    if (this.canUpload(userId)) rows.push([btn("🛠 پنل آپلود", "admin:home", "primary")]);
    if (role === "owner" || role === "full") rows.push([btn("⚙️ مدیریت", "manage:home", "primary")]);
    return { inline_keyboard: rows };
  }

  async sendUser(userId, text, replyMarkup = null, forceEmpty = false) {
    if (!String(text || "").trim() && !forceEmpty) return null;
    return telegram(this.env, "sendMessage", {
      chat_id: String(userId),
      text: String(text || " "),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: replyMarkup || undefined
    });
  }

  uploadModeKeyboard() {
    return {
      inline_keyboard: [
        [btn("⛔ پایان", "upload:stop", "danger")],
        [btn("🏠 خانه", "user:home", "primary")]
      ]
    };
  }

  async startUpload(userId, mode) {
    this.requireRole(userId, "upload");
    const setId = this.newUploadSet(userId, mode);
    this.setSession(userId, "upload", { setId, mode, count: 0 });
    const text = mode === "single"
      ? "📥 حالت تک‌فایل فعال شد. حداکثر ۱۰ فایل را یکی‌یکی بفرست؛ بعد از هر فایل لینک همان فایل را می‌گیری. برای پایان روی دکمه بزن."
      : "📚 حالت چندتایی فعال شد. فایل‌ها را بفرست؛ وقتی تمام شد روی «پایان» بزن تا لینک همه فایل‌ها یکجا ارسال شود.";
    return this.sendUser(userId, text, this.uploadModeKeyboard());
  }

  async handleUploadMessage(message, session) {
    const userId = String(message.from.id);
    if (!this.canUpload(userId)) throw new Error("You do not have upload permission.");
    if (!isUploadMessage(message)) {
      await this.sendUser(userId, "📎 فقط فایل/رسانه ارسال کن.", this.uploadModeKeyboard());
      return;
    }
    const data = session.data || {};
    const mode = String(data.mode || "single");
    const setId = Number(data.setId || 0);
    const count = Number(data.count || 0);
    if (!setId) throw new Error("Upload session is invalid.");
    const limit = mode === "single" ? CONFIG.MAX_SINGLE_UPLOADS : CONFIG.MAX_MULTI_UPLOADS;
    if (count >= limit) {
      this.clearSession(userId);
      throw new Error(`Maximum ${limit} files reached. Start a new upload session.`);
    }
    const file = await this.storeMessage(message, userId);
    const position = this.addSetItem(setId, Number(file.id));
    this.setSession(userId, "upload", { ...data, count: count + 1 });
    const link = this.fileLink(file.token);
    if (mode === "single") {
      await this.sendUser(userId, `✅ فایل ${position}/${limit} ذخیره شد.\n\n${escapeHtml(messageLabel(message))}\n${escapeHtml(link)}`, this.uploadModeKeyboard());
      if (count + 1 >= limit) {
        this.clearSession(userId);
        await this.sendUser(userId, "✅ سقف ۱۰ فایل رسید؛ حالت آپلود بسته شد.", this.userKeyboard(userId));
      }
      return;
    }
    await this.sendUser(userId, `✅ فایل ${position} ذخیره شد. برای فایل بعدی ارسال کن؛ در پایان دکمه «⛔ پایان» را بزن.`, this.uploadModeKeyboard());
  }

  async finishUpload(userId) {
    const session = this.session(userId);
    if (!session || session.mode !== "upload") return this.sendUser(userId, "آپلود فعالی ندارید.", this.userKeyboard(userId));
    const setId = Number(session.data?.setId || 0);
    const mode = String(session.data?.mode || "single");
    this.clearSession(userId);
    this.closeSet(setId);
    const items = this.setItems(setId);
    if (!items.length) return this.sendUser(userId, "هیچ فایلی در این آپلود ثبت نشد.", this.userKeyboard(userId));
    const lines = ["✅ آپلود کامل شد.", ""];
    items.forEach((item, index) => lines.push(`${index + 1}. ${escapeHtml(item.label || item.kind)} — ${escapeHtml(this.fileLink(item.token))}`));
    if (mode === "single") lines.push("", "لینک‌ها همان زمانِ هر آپلود نیز ارسال شدند.");
    await this.sendUser(userId, lines.join("\n"), this.userKeyboard(userId));
  }

  async deleteFile(userId, fileId) {
    const role = this.roleFor(userId);
    const file = this.first(`SELECT * FROM files WHERE id = ?`, Number(fileId));
    if (!file || Number(file.deleted)) throw new Error("File not found.");
    if (!(role === "owner" || role === "full" || (role === "upload" && String(file.owner_id) === String(userId)))) throw new Error("You can only delete your own uploaded posts.");
    this.ctx.storage.sql.exec(`UPDATE files SET deleted = 1 WHERE id = ?`, Number(fileId));
    const settings = this.getSettings();
    await safeTelegram(this.env, "deleteMessage", { chat_id: settings.storage_chat_id, message_id: Number(file.storage_message_id) });
    return this.sendUser(userId, `🗑 فایل #${file.id} حذف شد.`, this.adminKeyboard(userId));
  }

  async editFile(userId, fileId) {
    const role = this.roleFor(userId);
    const file = this.first(`SELECT * FROM files WHERE id = ? AND deleted = 0`, Number(fileId));
    if (!file) throw new Error("File not found.");
    if (!(role === "owner" || role === "full" || (role === "upload" && String(file.owner_id) === String(userId)))) throw new Error("You can only edit your own uploaded posts.");
    this.setSession(userId, "edit_file", { fileId: Number(fileId) });
    return this.sendUser(userId, "✏️ کپشن جدید را در پیام بعدی بفرست. برای حذف کپشن `/none` بفرست.");
  }

  async saveEditedFile(userId, caption) {
    const session = this.session(userId);
    if (!session || session.mode !== "edit_file") return false;
    const fileId = Number(session.data?.fileId || 0);
    const file = this.first(`SELECT * FROM files WHERE id = ? AND deleted = 0`, fileId);
    if (!file) throw new Error("File not found.");
    const role = this.roleFor(userId);
    if (!(role === "owner" || role === "full" || (role === "upload" && String(file.owner_id) === String(userId)))) throw new Error("Access denied.");
    const value = String(caption || "").trim() === "/none" ? "" : String(caption || "").trim().slice(0, 1024);
    const settings = this.getSettings();
    try {
      await telegram(this.env, "editMessageCaption", { chat_id: settings.storage_chat_id, message_id: Number(file.storage_message_id), caption: value });
    } catch (error) {
      throw new Error(`Caption edit failed: ${String(error?.message || error)}`);
    }
    this.ctx.storage.sql.exec(`UPDATE files SET caption = ? WHERE id = ?`, value, fileId);
    this.clearSession(userId);
    return this.sendUser(userId, "✅ کپشن ویرایش شد.", this.adminKeyboard(userId));
  }

  adminKeyboard(userId) {
    const role = this.roleFor(userId);
    const rows = [
      [btn("📥 تک‌فایل", "upload:single", "success"), btn("📚 چندتایی", "upload:multi", "success")],
      [btn("📋 فایل‌های من", "admin:list", "primary")]
    ];
    if (role === "owner" || role === "full") rows.push([btn("📊 آمار", "stats:show", "primary"), btn("👥 کاربران", "users:list", "primary")], [btn("⚙️ تنظیمات", "manage:home", "primary")]);
    rows.push([btn("🏠 خانه", "user:home", "primary")]);
    return { inline_keyboard: rows };
  }

  async adminList(userId) {
    const role = this.roleFor(userId);
    const files = role === "upload"
      ? this.all(`SELECT * FROM files WHERE owner_id = ? AND deleted = 0 ORDER BY id DESC LIMIT 50`, String(userId))
      : this.all(`SELECT * FROM files WHERE deleted = 0 ORDER BY id DESC LIMIT 50`);
    if (!files.length) return this.sendUser(userId, "📋 هیچ فایل فعالی پیدا نشد.", this.adminKeyboard(userId));
    const rows = files.slice(0, 50).map(file => [
      btn(`✏️ #${file.id}`, `file:edit:${file.id}`, "primary"),
      btn(`🗑 #${file.id}`, `file:del:${file.id}`, "danger")
    ]);
    const header = role === "upload" ? "📋 فایل‌های شما" : "📋 آخرین فایل‌ها";
    return this.sendUser(userId, `${header}\n\n${files.map(file => `#${file.id} — ${shortText(file.label, 70)} — ${file.token}`).join("\n")}`, { inline_keyboard: [...rows, [btn("🏠 پنل", "admin:home", "primary")]] });
  }

  async broadcastInput(userId) {
    this.requireRole(userId, "full");
    if (!this.getSettings().storage_chat_id) throw new Error("Storage channel is not configured.");
    this.setSession(userId, "broadcast", {});
    return this.sendUser(userId, "📣 پیام Broadcast را بفرست. متن، عکس، ویدیو، فایل یا GIF قابل ارسال است. پیام برای کاربران از کانال حافظه Copy می‌شود تا نام فرستنده نمایش داده نشود.");
  }

  async createBroadcast(userId, message) {
    const settings = this.getSettings();
    const copied = await telegram(this.env, "copyMessage", {
      chat_id: settings.storage_chat_id,
      from_chat_id: String(message.chat.id),
      message_id: Number(message.message_id),
      disable_notification: true
    });
    const broadcastId = this.execInsertId(`INSERT INTO broadcasts(storage_message_id, created_by, created_at) VALUES(?, ?, ?)`, Number(copied.message_id), String(userId), now());
    this.clearSession(userId);
    await this.scheduleAlarmSoon();
    return this.sendUser(userId, `📣 Broadcast #${broadcastId} شروع شد. ارسال به‌صورت batch انجام می‌شود تا Worker تحت فشار قرار نگیرد.`, this.adminKeyboard(userId));
  }

  async processBroadcasts() {
    const broadcast = this.first(`SELECT * FROM broadcasts WHERE status = 'running' ORDER BY id ASC LIMIT 1`);
    if (!broadcast) return;
    const users = this.all(`
      SELECT user_id FROM users
      WHERE blocked = 0 AND user_id > ?
      ORDER BY user_id ASC
      LIMIT ?
    `, String(broadcast.last_user_id || ""), CONFIG.MAX_BROADCAST_BATCH);
    if (!users.length) {
      this.ctx.storage.sql.exec(`UPDATE broadcasts SET status = 'done' WHERE id = ?`, Number(broadcast.id));
      return;
    }
    let last = String(broadcast.last_user_id || "");
    let sent = Number(broadcast.sent_count || 0);
    let failed = Number(broadcast.failed_count || 0);
    for (const user of users) {
      last = String(user.user_id);
      try {
        await telegram(this.env, "copyMessage", {
          chat_id: String(user.user_id),
          from_chat_id: String(this.getSettings().storage_chat_id),
          message_id: Number(broadcast.storage_message_id),
          disable_notification: false
        });
        sent++;
      } catch (error) {
        failed++;
        const description = String(error?.message || "");
        if (/blocked|deactivated|chat not found|user is deactivated/i.test(description)) {
          this.ctx.storage.sql.exec(`UPDATE users SET blocked = 1 WHERE user_id = ?`, String(user.user_id));
        }
      }
    }
    this.ctx.storage.sql.exec(`UPDATE broadcasts SET last_user_id = ?, sent_count = ?, failed_count = ? WHERE id = ?`, last, sent, failed, Number(broadcast.id));
    await this.scheduleAlarmSoon();
  }

  async scheduleAlarmSoon(delay = 1000) {
    const target = now() + Math.max(100, Number(delay));
    const current = await this.ctx.storage.getAlarm();
    if (current == null || Number(current) > target) await this.ctx.storage.setAlarm(target);
  }

  requiredChannelsText() {
    const rows = this.all(`SELECT * FROM channels WHERE active = 1 ORDER BY id ASC`);
    if (!rows.length) return "📢 هیچ کانال اجباری ثبت نشده است.";
    return rows.map(row => `#${row.id} — ${shortText(row.title || row.username || row.chat_id, 60)} — ${row.username || row.chat_id}`).join("\n");
  }

  async managementPanel(userId) {
    this.requireRole(userId, "full");
    const settings = this.getSettings();
    const admins = this.all(`SELECT * FROM admins ORDER BY created_at DESC`);
    const users = Number(this.first(`SELECT COUNT(*) AS count FROM users`)?.count || 0);
    const files = Number(this.first(`SELECT COUNT(*) AS count FROM files WHERE deleted = 0`)?.count || 0);
    const text = [
      "⚙️ <b>مدیریت ربات</b>",
      "",
      `👥 Users: <b>${users}</b>`,
      `📦 Active files: <b>${files}</b>`,
      `🧠 Storage: <b>${escapeHtml(settings.storage_title || settings.storage_chat_id || "تنظیم نشده")}</b>`,
      `🎫 Tickets: <b>${escapeHtml(settings.ticket_title || settings.ticket_chat_id || "تنظیم نشده")}</b>`,
      `📎 Suffix: <b>${escapeHtml(settings.suffix || "خاموش")}</b>`,
      `👋 Welcome: <b>${settings.welcome_message_id ? "configured" : "not configured"}</b>`,
      "",
      "📢 Required channels:",
      escapeHtml(this.requiredChannelsText()),
      "",
      `👑 Admins: ${admins.length}`
    ].join("\n");
    return this.sendUser(userId, text, this.manageKeyboard(userId));
  }

  manageKeyboard(userId) {
    const rows = [
      [btn("💾 Storage Channel", "cfg:storage", "primary"), btn("🎫 Ticket Channel", "cfg:ticket", "primary")],
      [btn("📢 Required Channels", "cfg:channels", "primary"), btn("👋 Welcome", "cfg:welcome", "primary")],
      [btn("📝 Suffix", "cfg:suffix", "primary"), btn("📣 Broadcast", "cfg:broadcast", "primary")],
      [btn("📊 Statistics", "stats:show", "primary"), btn("👥 Users", "users:list", "primary")],
      [btn("🛡 Admins", "admins:list", "primary")]
    ];
    if (this.roleFor(userId) === "owner") rows.push([btn("➕ Add Admin", "admins:add", "success")]);
    rows.push([btn("🔄 Refresh", "manage:home", "primary"), btn("🏠 Home", "user:home", "primary")]);
    return { inline_keyboard: rows };
  }

  async setSuffix(userId) {
    this.requireRole(userId, "full");
    this.setSession(userId, "suffix", {});
    return this.sendUser(userId, `📝 متن انتهایی فایل‌ها را بفرست. حداکثر ${CONFIG.MAX_SUFFIX_LENGTH} کاراکتر. برای خاموش کردن /none بفرست.`);
  }

  async setWelcome(userId) {
    this.requireRole(userId, "full");
    if (!this.getSettings().storage_chat_id) throw new Error("اول Storage Channel را تنظیم کن.");
    this.setSession(userId, "welcome", {});
    return this.sendUser(userId, "👋 پیام خوش‌آمدگویی را بفرست. هر نوع پیام قابل ذخیره است؛ ربات آن را داخل Storage Channel نگه می‌دارد و بعداً با copyMessage برای کاربران ارسال می‌کند.");
  }

  async saveWelcome(userId, message) {
    this.requireRole(userId, "full");
    const settings = this.getSettings();
    if (String(message?.text || "").trim() === "/none") {
      if (settings.welcome_message_id) await safeTelegram(this.env, "deleteMessage", { chat_id: settings.storage_chat_id, message_id: Number(settings.welcome_message_id) });
      this.updateSettings({ welcome_message_id: null, welcome_kind: "" });
      this.clearSession(userId);
      return this.sendUser(userId, "✅ Welcome خاموش شد.", this.manageKeyboard(userId));
    }
    const copied = await telegram(this.env, "copyMessage", {
      chat_id: settings.storage_chat_id,
      from_chat_id: String(message.chat.id),
      message_id: Number(message.message_id),
      disable_notification: true
    });
    const oldMessageId = Number(settings.welcome_message_id || 0);
    this.updateSettings({ welcome_message_id: Number(copied.message_id), welcome_kind: messageKind(message) });
    if (oldMessageId && oldMessageId !== Number(copied.message_id)) await safeTelegram(this.env, "deleteMessage", { chat_id: settings.storage_chat_id, message_id: oldMessageId });
    this.clearSession(userId);
    return this.sendUser(userId, "✅ Welcome Message ذخیره شد.", this.manageKeyboard(userId));
  }

  async addAdminInput(userId) {
    if (!this.canManageAdmins(userId)) throw new Error("Only the primary owner can manage admins.");
    this.setSession(userId, "admin_add", {});
    return this.sendUser(userId, "👤 آیدی عددی Telegram کاربر را بفرست. سپس نقش را انتخاب می‌کنی. کاربر باید حداقل یک‌بار با Bot تعامل کرده باشد تا بتوانی اطلاعاتش را ثبت کنی.");
  }

  async createAdmin(userId, targetId) {
    if (!this.canManageAdmins(userId)) throw new Error("Only the primary owner can manage admins.");
    const value = String(targetId || "").trim();
    if (!/^\d+$/.test(value)) throw new Error("Telegram user ID must be numeric.");
    if (value === getOwnerId(this.env)) throw new Error("Primary owner cannot be added as an admin.");
    const existing = this.first(`SELECT user_id FROM admins WHERE user_id = ?`, value);
    const current = Number(this.first(`SELECT COUNT(*) AS count FROM admins`)?.count || 0);
    if (!existing && current >= CONFIG.MAX_ADMINS) throw new Error(`Maximum ${CONFIG.MAX_ADMINS} admins allowed.`);
    this.setSession(userId, "admin_role", { targetId: value });
    return this.sendUser(userId, "نقش ادمین را انتخاب کن:", {
      inline_keyboard: [[btn("📤 Upload Admin", `admin:addrole:upload`, "primary"), btn("👑 Full Admin", `admin:addrole:full`, "danger")], [btn("↩️ لغو", "manage:home", "primary")]]
    });
  }

  async saveAdmin(userId, role) {
    if (!this.canManageAdmins(userId)) throw new Error("Only the primary owner can manage admins.");
    const session = this.session(userId);
    const targetId = String(session?.data?.targetId || "");
    if (!targetId) throw new Error("Admin setup session expired.");
    if (!["upload", "full"].includes(role)) throw new Error("Invalid admin role.");
    this.ctx.storage.sql.exec(`
      INSERT INTO admins(user_id, username, role, created_at, created_by)
      VALUES(?, '', ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET role = excluded.role, created_at = excluded.created_at, created_by = excluded.created_by
    `, targetId, role, now(), String(userId));
    this.clearSession(userId);
    await safeTelegram(this.env, "sendMessage", { chat_id: targetId, text: `✅ شما به عنوان ${adminRoleLabel(role)} ثبت شدید.` });
    return this.sendUser(userId, `✅ ادمین ${targetId} با نقش ${adminRoleLabel(role)} ثبت شد.`, this.manageKeyboard(userId));
  }

  async adminListManagement(userId) {
    this.requireRole(userId, "full");
    const admins = this.all(`
      SELECT a.*, u.first_name, u.last_name, u.username AS live_username
      FROM admins a
      LEFT JOIN users u ON u.user_id = a.user_id
      ORDER BY a.created_at DESC
    `);
    if (!admins.length) return this.sendUser(userId, "👥 هیچ ادمینی ثبت نشده است.", this.manageKeyboard(userId));
    const text = admins.map(admin => {
      const name = shortText([admin.first_name, admin.last_name].filter(Boolean).join(" ") || "User", 28);
      const username = shortText(normalizeUsername(admin.live_username || admin.username || "unknown"), 18);
      return `<a href="tg://user?id=${encodeURIComponent(admin.user_id)}">${escapeHtml(name)}</a> · <code>${escapeHtml(admin.user_id)}</code> · ${adminRoleLabel(admin.role)} · @${escapeHtml(username)}`;
    }).join("\n");
    if (text.length > CONFIG.TELEGRAM_SAFE_TEXT) throw new Error("Admin list is too large. Remove some admins or use the paginated view.");
    const buttons = admins.flatMap(admin => [[btn(`🗑 حذف ${admin.user_id}`, `admin:del:${admin.user_id}`, "danger")]]);
    buttons.push([btn("🏠 مدیریت", "manage:home", "primary")]);
    return this.sendUser(userId, `👥 <b>Admins</b>\n\n${text}`, { inline_keyboard: buttons });
  }

  async deleteAdmin(userId, targetId) {
    this.requireRole(userId, "owner");
    const target = String(targetId || "");
    if (target === getOwnerId(this.env)) throw new Error("Primary owner cannot be deleted.");
    this.ctx.storage.sql.exec(`DELETE FROM admins WHERE user_id = ?`, target);
    return this.sendUser(userId, `🗑 Admin ${target} حذف شد.`, this.manageKeyboard(userId));
  }

  async stats(userId) {
    this.requireRole(userId, "full");
    const users = Number(this.first(`SELECT COUNT(*) AS count FROM users`)?.count || 0);
    const activeUsers = Number(this.first(`SELECT COUNT(*) AS count FROM users WHERE last_seen_at >= ?`, now() - 86_400_000)?.count || 0);
    const premium = Number(this.first(`SELECT COUNT(*) AS count FROM users WHERE premium_permanent = 1 OR premium_until > ?`, now())?.count || 0);
    const files = Number(this.first(`SELECT COUNT(*) AS count FROM files WHERE deleted = 0`)?.count || 0);
    const qualified = Number(this.first(`SELECT COUNT(*) AS count FROM referrals WHERE qualified = 1`)?.count || 0);
    const tickets = Number(this.first(`SELECT COUNT(*) AS count FROM tickets WHERE status = 'pending'`)?.count || 0);
    const broadcasts = Number(this.first(`SELECT COUNT(*) AS count FROM broadcasts WHERE status = 'running'`)?.count || 0);
    const requests = Number(this.first(`SELECT COALESCE(SUM(request_count), 0) AS total FROM users`)?.total || 0);
    const uploads = Number(this.first(`SELECT COALESCE(SUM(upload_count), 0) AS total FROM users`)?.total || 0);
    const downloads = Number(this.first(`SELECT COALESCE(SUM(download_count), 0) AS total FROM users`)?.total || 0);
    return this.sendUser(userId, [
      "📊 <b>Statistics</b>",
      "",
      `Users: <b>${users}</b>`,
      `Active 24h: <b>${activeUsers}</b>`,
      `Premium: <b>${premium}</b>`,
      `Active files: <b>${files}</b>`,
      `Requests: <b>${requests}</b>`,
      `Uploads: <b>${uploads}</b>`,
      `Downloads: <b>${downloads}</b>`,
      `Qualified referrals: <b>${qualified}</b>`,
      `Pending tickets: <b>${tickets}</b>`,
      `Running broadcasts: <b>${broadcasts}</b>`
    ].join("\n"), this.manageKeyboard(userId));
  }

  userDisplayName(user) {
    return shortText([user?.first_name, user?.last_name].filter(Boolean).join(" ") || (user?.username ? `@${user.username}` : "User"), 70);
  }

  async usersPage(userId, page = 0) {
    this.requireRole(userId, "full");
    const safePage = Math.max(0, Math.floor(Number(page) || 0));
    const offset = safePage * 50;
    const total = Number(this.first(`SELECT COUNT(*) AS count FROM users`)?.count || 0);
    const users = this.all(`
      SELECT * FROM users
      ORDER BY last_seen_at DESC, user_id ASC
      LIMIT 50 OFFSET ?
    `, offset);
    if (!users.length && safePage > 0) return this.usersPage(userId, safePage - 1);
    const userLines = users.map((user, index) => {
      const name = shortText(this.userDisplayName(user), 24);
      const username = user.username ? ` · @${escapeHtml(shortText(normalizeUsername(user.username), 18))}` : "";
      return `${offset + index + 1}. <a href="tg://user?id=${encodeURIComponent(user.user_id)}">${escapeHtml(name)}</a> · <code>${escapeHtml(user.user_id)}</code>${username} · req:${Number(user.request_count || 0)} · up:${Number(user.upload_count || 0)} · dl:${Number(user.download_count || 0)}`;
    });
    let lines = [
      `👥 <b>Users</b> · page ${safePage + 1}`,
      `Total: <b>${total}</b>`,
      "",
      ...userLines
    ];
    if (lines.join("\n").length > CONFIG.TELEGRAM_SAFE_TEXT) {
      lines = [
        `👥 <b>Users</b> · page ${safePage + 1} · ${total}`,
        "",
        ...users.map((user, index) => `${offset + index + 1}. <a href="tg://user?id=${encodeURIComponent(user.user_id)}">${escapeHtml(shortText(this.userDisplayName(user), 18))}</a> · req:${Number(user.request_count || 0)} · dl:${Number(user.download_count || 0)}`)
      ];
    }
    const rows = users.map(user => [btn(`👁 ${shortText(this.userDisplayName(user), 28)}`, `users:view:${user.user_id}`, "primary")]);
    const nav = [];
    if (safePage > 0) nav.push(btn("◀️ قبلی", `users:page:${safePage - 1}`, "primary"));
    if (offset + users.length < total) nav.push(btn("بعدی ▶️", `users:page:${safePage + 1}`, "primary"));
    if (nav.length) rows.push(nav);
    rows.push([btn("🔄 Refresh", `users:page:${safePage}`, "primary"), btn("🏠 مدیریت", "manage:home", "primary")]);
    return this.sendUser(userId, lines.join("\n"), { inline_keyboard: rows });
  }

  async userDetails(userId, targetId) {
    this.requireRole(userId, "full");
    const id = String(targetId || "");
    const user = this.first(`SELECT * FROM users WHERE user_id = ?`, id);
    if (!user) throw new Error("User not found.");
    const referrals = Number(this.first(`SELECT COUNT(*) AS count FROM referrals WHERE referrer_id = ? AND qualified = 1`, id)?.count || 0);
    const premium = Number(user.premium_permanent) ? "دائم" : Number(user.premium_until || 0) > now() ? formatRemaining(Number(user.premium_until) - now()) : "غیرفعال";
    const username = user.username ? `@${escapeHtml(normalizeUsername(user.username))}` : "-";
    const name = this.userDisplayName(user);
    const text = [
      "👤 <b>User Details</b>",
      "",
      `Name: <a href="tg://user?id=${encodeURIComponent(id)}">${escapeHtml(name)}</a>`,
      `ID: <code>${escapeHtml(id)}</code>`,
      `Username: <b>${username}</b>`,
      `Joined: <code>${new Date(Number(user.joined_at)).toISOString()}</code>`,
      `Last seen: <code>${new Date(Number(user.last_seen_at)).toISOString()}</code>`,
      "",
      `Requests: <b>${Number(user.request_count || 0)}</b>`,
      `Uploads: <b>${Number(user.upload_count || 0)}</b>`,
      `Downloads: <b>${Number(user.download_count || 0)}</b>`,
      `Free used: <b>${Number(user.downloads_used || 0)}/${CONFIG.FREE_DOWNLOADS}</b>`,
      `Referral credits: <b>${Number(user.referral_downloads || 0)}</b>`,
      `Successful referrals: <b>${referrals}</b>`,
      `Premium: <b>${premium}</b>`,
      `Blocked: <b>${Number(user.blocked) ? "YES" : "NO"}</b>`
    ].join("\n");
    return this.sendUser(userId, text, {
      inline_keyboard: [
        [btn("💬 ارسال پیام", `users:message:${id}`, "success")],
        [btn("👤 بازگشت به Users", "users:list", "primary"), btn("🏠 مدیریت", "manage:home", "primary")]
      ]
    });
  }

  async startUserMessage(userId, targetId) {
    this.requireRole(userId, "full");
    const target = String(targetId || "");
    const user = this.first(`SELECT user_id FROM users WHERE user_id = ?`, target);
    if (!user) throw new Error("User not found.");
    this.setSession(userId, "admin_user_message", { targetId: target });
    return this.sendUser(userId, `💬 پیام برای <code>${escapeHtml(target)}</code> را در پیام بعدی بفرست. متن، عکس، ویدیو، فایل و سایر پیام‌های قابل کپی پشتیبانی می‌شوند.\n\nبرای لغو /cancel را بفرست.`);
  }

  async sendDirectUserMessage(userId, message) {
    this.requireRole(userId, "full");
    const session = this.session(userId);
    const targetId = String(session?.data?.targetId || "");
    if (!targetId) throw new Error("User message session expired.");
    const target = this.first(`SELECT user_id, blocked FROM users WHERE user_id = ?`, targetId);
    if (!target) throw new Error("User not found.");
    try {
      await telegram(this.env, "copyMessage", {
        chat_id: targetId,
        from_chat_id: String(message.chat.id),
        message_id: Number(message.message_id),
        protect_content: false
      });
    } catch (error) {
      if (/blocked|deactivated|chat not found|user is deactivated/i.test(String(error?.message || error))) this.ctx.storage.sql.exec(`UPDATE users SET blocked = 1 WHERE user_id = ?`, targetId);
      throw new Error(`ارسال پیام ناموفق بود: ${String(error?.message || error)}`);
    }
    this.clearSession(userId);
    this.ctx.storage.sql.exec(`UPDATE users SET blocked = 0 WHERE user_id = ?`, targetId);
    return this.sendUser(userId, `✅ پیام برای <code>${escapeHtml(targetId)}</code> ارسال شد.`, this.manageKeyboard(userId));
  }

  async ticketPurchase(userId) {
    const settings = this.getSettings();
    if (!settings.ticket_chat_id) throw new Error("Ticket channel is not configured.");
    if (this.isPremium(userId)) {
      const user = this.first(`SELECT premium_until, premium_permanent FROM users WHERE user_id = ?`, String(userId));
      const label = Number(user.premium_permanent) ? "دائم" : formatRemaining(Number(user.premium_until) - now());
      return this.sendUser(userId, `💎 Premium شما فعال است. باقی‌مانده: ${label}`);
    }
    const today = unixDay();
    let ticketId = 0;
    try {
      ticketId = this.execInsertId(`INSERT INTO tickets(user_id, ticket_day, channel_message_id, created_at, status) VALUES(?, ?, 0, ?, 'pending')`, String(userId), today, now());
    } catch (error) {
      if (/unique|constraint/i.test(String(error?.message || error))) return this.sendUser(userId, "🎫 امروز یک Ticket برای خرید Premium ثبت کرده‌ای. تا تعیین تکلیف همان Ticket، Ticket دیگری در همان روز ساخته نمی‌شود.");
      throw error;
    }
    const user = this.first(`SELECT * FROM users WHERE user_id = ?`, String(userId));
    const name = shortText([user?.first_name, user?.last_name].filter(Boolean).join(" ") || "User", 80);
    const username = user?.username ? `@${normalizeUsername(user.username)}` : "بدون username";
    try {
      const message = await telegram(this.env, "sendMessage", {
        chat_id: settings.ticket_chat_id,
        text: [
          "🎫 <b>Premium Ticket</b>",
          "",
          `Ticket ID: <code>${ticketId}</code>`,
          `User ID: <code>${escapeHtml(userId)}</code>`,
          `Name: <b>${escapeHtml(name)}</b>`,
          `Username: <b>${escapeHtml(username)}</b>`,
          `Created: <code>${new Date().toISOString()}</code>`,
          "",
          "برای تعیین مدت Premium روی تأیید کلیک کنید."
        ].join("\n"),
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [btn("✅ تأیید Premium", `ticket:approve:${ticketId}`, "success")]
          ]
        }
      });
      this.ctx.storage.sql.exec(`UPDATE tickets SET channel_message_id = ? WHERE id = ?`, Number(message?.message_id || 0), ticketId);
    } catch (error) {
      this.ctx.storage.sql.exec(`DELETE FROM tickets WHERE id = ? AND status = 'pending'`, ticketId);
      throw error;
    }
    return this.sendUser(userId, "🎫 Ticket ثبت شد و به بخش خرید Premium ارسال شد. حداکثر روزی یک Ticket تا زمان فعال شدن Premium.");
  }

  premiumDurations(userId) {
    this.requireRole(userId, "full");
    return this.sendUser(userId, "مدت Premium را انتخاب کن:", {
      inline_keyboard: [
        [btn("1 روز", "premium:dur:1d", "primary"), btn("1 هفته", "premium:dur:7d", "primary")],
        [btn("1 ماه", "premium:dur:30d", "primary"), btn("3 ماه", "premium:dur:90d", "primary")],
        [btn("6 ماه", "premium:dur:180d", "primary"), btn("1 سال", "premium:dur:365d", "primary")],
        [btn("♾ دائم", "premium:dur:perm", "danger")]
      ]
    });
  }

  async approveTicketPrompt(userId, ticketId) {
    this.requireRole(userId, "full");
    const ticket = this.first(`SELECT * FROM tickets WHERE id = ? AND status = 'pending'`, Number(ticketId));
    if (!ticket) throw new Error("Pending ticket not found.");
    const ticketChatId = String(this.getSettings().ticket_chat_id || "");
    const activeMessageId = Number(ticket.channel_message_id || 0);
    if (!ticketChatId || !activeMessageId) throw new Error("Ticket message is invalid.");
    this.setSession(userId, "premium_approve", { ticketId: Number(ticket.id), targetUserId: String(ticket.user_id) });
    return this.premiumDurations(userId);
  }

  parseDurationCode(code) {
    const match = String(code || "").match(/^(1|7|30|90|180|365)d$/);
    if (!match) return null;
    return Number(match[1]) * 86_400_000;
  }

  async activatePremium(userId, durationCode) {
    this.requireRole(userId, "full");
    const session = this.session(userId);
    if (!session || session.mode !== "premium_approve") throw new Error("Premium approval session expired.");
    const ticketId = Number(session.data?.ticketId || 0);
    const targetUserId = String(session.data?.targetUserId || "");
    const duration = this.parseDurationCode(durationCode);
    if (!targetUserId || (!duration && durationCode !== "perm")) throw new Error("Invalid Premium duration.");
    if (durationCode === "perm") {
      this.ctx.storage.sql.exec(`UPDATE users SET premium_permanent = 1, premium_until = 0 WHERE user_id = ?`, targetUserId);
    } else {
      const user = this.first(`SELECT premium_until FROM users WHERE user_id = ?`, targetUserId);
      const base = Math.max(now(), Number(user?.premium_until || 0));
      this.ctx.storage.sql.exec(`UPDATE users SET premium_until = ?, premium_permanent = 0 WHERE user_id = ?`, base + duration, targetUserId);
    }
    const current = this.first(`SELECT premium_until, premium_permanent FROM users WHERE user_id = ?`, targetUserId);
    const label = durationCode === "perm" ? "دائم" : durationCode;
    this.ctx.storage.sql.exec(`UPDATE tickets SET status = 'approved', premium_until = ?, premium_label = ? WHERE id = ?`, Number(current?.premium_until || 0), label, ticketId);
    this.clearSession(userId);
    await safeTelegram(this.env, "editMessageReplyMarkup", {
      chat_id: String(this.getSettings().ticket_chat_id),
      message_id: Number(this.first(`SELECT channel_message_id FROM tickets WHERE id = ?`, ticketId)?.channel_message_id || 0),
      reply_markup: { inline_keyboard: [[btn("✅ Approved", "ticket:done", "success")]] }
    });
    await safeTelegram(this.env, "sendMessage", {
      chat_id: targetUserId,
      text: `💎 Premium شما فعال شد.\nمدت: ${label}`,
      reply_markup: this.userKeyboard(targetUserId)
    });
    return this.sendUser(userId, `✅ Premium برای ${targetUserId} فعال شد: ${label}`, this.manageKeyboard(userId));
  }

  async handleUserStart(message, startArg) {
    const userId = String(message.from.id);
    this.upsertUser(message.from);
    const currentSettings = this.getSettings();
    if (!currentSettings.bot_username) await this.getBotInfo();
    const existing = this.first(`SELECT referral_invited_by FROM users WHERE user_id = ?`, userId);
    const arg = String(startArg || "");
    if (!existing?.referral_invited_by && arg.startsWith("ref_")) {
      const referrer = String(arg.slice(4) || "");
      if (/^\d+$/.test(referrer) && referrer !== userId && this.first(`SELECT user_id FROM users WHERE user_id = ?`, referrer)) {
        this.ctx.storage.sql.exec(`UPDATE users SET referral_invited_by = ? WHERE user_id = ? AND referral_invited_by IS NULL`, referrer, userId);
      }
    }
    if (arg.startsWith("file_")) {
      const token = String(arg.slice(5) || "");
      const file = this.first(`SELECT * FROM files WHERE token = ? AND deleted = 0`, token);
      if (!file) throw new Error("لینک فایل نامعتبر یا منقضی شده است.");
      await this.deliverFile(userId, file);
      return;
    }
    const membership = await this.channelsSatisfied(userId);
    await this.qualifyReferral(userId, membership);
    await this.sendWelcome(userId);
    if (!membership.ok) await this.sendMembershipGate(userId, membership.missing);
  }

  async processCallback(update) {
    const callback = update?.callback_query;
    const userId = String(callback?.from?.id || "");
    if (!userId) return;
    this.upsertUser(callback.from);
    this.recordRequest(userId);
    await safeTelegram(this.env, "answerCallbackQuery", { callback_query_id: callback.id });
    const data = String(callback.data || "");
    const message = callback.message;
    try {
      if (data === "gate:check") {
        if (await this.gate(userId, true)) await this.sendUser(userId, "✅ عضویت کامل تأیید شد. حالا می‌توانی لینک فایل را باز کنی.", this.userKeyboard(userId));
        return;
      }
      if (data === "user:home") return await this.sendUser(userId, "🏠 خانه", this.userKeyboard(userId));
      if (data === "user:quota") return await this.sendQuotaPage(userId);
      if (data === "premium:buy") return await this.ticketPurchase(userId);
      if (data === "upload:single") return await this.startUpload(userId, "single");
      if (data === "upload:multi") return await this.startUpload(userId, "multi");
      if (data === "upload:stop") return await this.finishUpload(userId);
      if (data === "admin:home") {
        this.requireRole(userId, "upload");
        return await this.sendUser(userId, "🛠 پنل آپلود", this.adminKeyboard(userId));
      }
      if (data === "admin:list") return await this.adminList(userId);
      if (data.startsWith("file:del:")) {
        return await this.deleteFile(userId, data.slice("file:del:".length));
      }
      if (data.startsWith("file:edit:")) return await this.editFile(userId, data.slice("file:edit:".length));
      if (data === "manage:home") return await this.managementPanel(userId);
      if (data === "users:list") return await this.usersPage(userId, 0);
      if (data.startsWith("users:page:")) return await this.usersPage(userId, data.slice("users:page:".length));
      if (data.startsWith("users:view:")) return await this.userDetails(userId, data.slice("users:view:".length));
      if (data.startsWith("users:message:")) return await this.startUserMessage(userId, data.slice("users:message:".length));
      if (data === "stats:show") return await this.stats(userId);
      if (data === "admins:list") return await this.adminListManagement(userId);
      if (data === "admins:add") return await this.addAdminInput(userId);
      if (data.startsWith("admin:addrole:")) return await this.saveAdmin(userId, data.slice("admin:addrole:".length));
      if (data.startsWith("admin:del:")) return await this.deleteAdmin(userId, data.slice("admin:del:".length));
      if (data === "cfg:storage") {
        this.requireRole(userId, "full");
        this.setSession(userId, "channel_storage", {});
        return await this.sendUser(userId, "💾 ID یا @username کانال Storage را بفرست. Bot باید آنجا Administrator باشد.");
      }
      if (data === "cfg:ticket") {
        this.requireRole(userId, "full");
        this.setSession(userId, "channel_ticket", {});
        return await this.sendUser(userId, "🎫 ID یا @username کانال Ticket را بفرست. Bot باید Administrator باشد.");
      }
      if (data === "cfg:channels") {
        this.requireRole(userId, "full");
        return await this.sendUser(userId, `📢 کانال‌های اجباری:\n\n${escapeHtml(this.requiredChannelsText())}`, {
          inline_keyboard: [
            [btn("➕ افزودن کانال", "cfg:channel_add", "success")],
            [btn("🗑 حذف کانال", "cfg:channel_delete", "danger")],
            [btn("🏠 مدیریت", "manage:home", "primary")]
          ]
        });
      }
      if (data === "cfg:channel_add") {
        this.requireRole(userId, "full");
        this.setSession(userId, "channel_required", {});
        return await this.sendUser(userId, "📢 ID یا @username کانال اجباری را بفرست. Bot باید Administrator باشد و کانال باید قابل عضویت باشد.");
      }
      if (data === "cfg:channel_delete") {
        this.requireRole(userId, "full");
        const channels = this.all(`SELECT id, title FROM channels WHERE active = 1 ORDER BY id`);
        return await this.sendUser(userId, "کانالی که می‌خواهی حذف شود:", { inline_keyboard: channels.map(channel => [btn(`🗑 #${channel.id} ${shortText(channel.title, 35)}`, `channel:del:${channel.id}`, "danger")]).concat([[btn("↩️ برگشت", "cfg:channels", "primary")]]) });
      }
      if (data.startsWith("channel:del:")) {
        this.requireRole(userId, "full");
        const id = Number(data.slice("channel:del:".length));
        this.ctx.storage.sql.exec(`DELETE FROM channels WHERE id = ?`, id);
        return await this.managementPanel(userId);
      }
      if (data === "cfg:welcome") return await this.setWelcome(userId);
      if (data === "cfg:suffix") return await this.setSuffix(userId);
      if (data === "cfg:broadcast") return await this.broadcastInput(userId);
      if (data === "ticket:done") return null;
      if (data.startsWith("ticket:approve:")) {
        this.requireRole(userId, "full");
        const ticketChatId = String(this.getSettings().ticket_chat_id || "");
        const ticketId = Number(data.slice("ticket:approve:".length));
        const ticket = this.first(`SELECT id, user_id, channel_message_id, status FROM tickets WHERE id = ?`, ticketId);
        if (!ticket || String(ticket.status) !== "pending") throw new Error("Pending ticket not found.");
        if (!message?.chat?.id || String(message.chat.id) !== ticketChatId) throw new Error("This ticket button is not valid here.");
        if (Number(message.message_id || 0) !== Number(ticket.channel_message_id || 0)) throw new Error("This ticket button is stale.");
        return await this.approveTicketPrompt(userId, ticketId);
      }
      if (data.startsWith("premium:dur:")) return await this.activatePremium(userId, data.slice("premium:dur:".length));
      if (data.startsWith("ref:copy:")) {
        return await this.sendUser(userId, `🔗 لینک دعوت شما:\n${this.refLink(userId) || "not ready"}`);
      }
      return await this.sendUser(userId, "دستور این دکمه منقضی شده است.", this.userKeyboard(userId));
    } catch (error) {
      await this.sendUser(userId, `❌ ${escapeHtml(String(error?.message || error))}`, this.userKeyboard(userId));
    }
  }

  async handleMessage(message) {
    const userId = String(message?.from?.id || "");
    if (!userId) return;
    this.upsertUser(message.from);
    this.recordRequest(userId);
    const parsedCommand = parseCommand(message.text || "");
    if (parsedCommand?.command === "/cancel") {
      this.clearSession(userId);
      return this.sendUser(userId, "❎ لغو شد.", this.userKeyboard(userId));
    }
    const session = this.session(userId);
    if (session?.mode === "upload") return this.handleUploadMessage(message, session);
    if (session?.mode === "edit_file") {
      const text = String(message.text || "").trim();
      return this.saveEditedFile(userId, text);
    }
    if (session?.mode === "broadcast") return this.createBroadcast(userId, message);
    if (session?.mode === "welcome") return this.saveWelcome(userId, message);
    if (session?.mode === "channel_storage") {
      this.requireRole(userId, "full");
      await this.setChannel(message.text, "storage");
      this.clearSession(userId);
      return this.sendUser(userId, "✅ Storage Channel تنظیم شد.", this.manageKeyboard(userId));
    }
    if (session?.mode === "channel_ticket") {
      this.requireRole(userId, "full");
      await this.setChannel(message.text, "ticket");
      this.clearSession(userId);
      return this.sendUser(userId, "✅ Ticket Channel تنظیم شد.", this.manageKeyboard(userId));
    }
    if (session?.mode === "channel_required") {
      this.requireRole(userId, "full");
      await this.setChannel(message.text, "required");
      this.clearSession(userId);
      return this.sendUser(userId, "✅ Required Channel ثبت شد.", this.manageKeyboard(userId));
    }
    if (session?.mode === "suffix") {
      this.requireRole(userId, "full");
      const value = String(message.text || "").trim();
      if (value === "/none") this.updateSettings({ suffix: "" });
      else {
        if (value.length > CONFIG.MAX_SUFFIX_LENGTH) throw new Error(`Suffix max length is ${CONFIG.MAX_SUFFIX_LENGTH}.`);
        this.updateSettings({ suffix: value });
      }
      this.clearSession(userId);
      return this.sendUser(userId, "✅ Suffix ذخیره شد.", this.manageKeyboard(userId));
    }
    if (session?.mode === "admin_add") {
      return this.createAdmin(userId, message.text);
    }
    if (session?.mode === "admin_user_message") return this.sendDirectUserMessage(userId, message);
    if (message.text) {
      const parsed = parseCommand(message.text);
      if (parsed) return this.command(message, parsed);
    }
    if (isUploadMessage(message) && this.canUpload(userId)) {
      return this.sendUser(userId, "یک حالت آپلود را از منو انتخاب کن.", this.adminKeyboard(userId));
    }
    if (isUploadMessage(message)) {
      return this.sendUser(userId, "📎 برای دریافت فایل، لینک فایل را باز کن.", this.userKeyboard(userId));
    }
    return this.sendUser(userId, "از منوی زیر استفاده کن.", this.userKeyboard(userId));
  }

  async command(message, parsed) {
    const userId = String(message.from.id);
    const command = parsed.command;
    const args = parsed.args;
    if (command === "/start") {
      return this.handleUserStart(message, args);
    }
    if (command === "/cancel") {
      this.clearSession(userId);
      return this.sendUser(userId, "❎ لغو شد.", this.userKeyboard(userId));
    }
    if (command === "/admin") {
      this.requireRole(userId, "upload");
      return this.sendUser(userId, "🛠 پنل آپلود", this.adminKeyboard(userId));
    }
    if (command === "/stats") return this.stats(userId);
    if (command === "/users") return this.usersPage(userId, 0);
    if (command === "/broadcast") return this.broadcastInput(userId);
    if (command === "/premium") return this.ticketPurchase(userId);
    if (command === "/id") return this.sendUser(userId, `🆔 User ID: <code>${escapeHtml(userId)}</code>`, this.userKeyboard(userId));
    return this.sendUser(userId, "❓ دستور ناشناخته است.", this.userKeyboard(userId));
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/telegram") return this.handleHttp(request, url);
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    if (!(await this.verifyWebhook(request))) return new Response("Unauthorized", { status: 401 });
    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    try {
      if (update?.callback_query) await this.processCallback(update);
      else if (update?.message) await this.handleMessage(update.message);
    } catch (error) {
      const chatId = update?.message?.chat?.id || update?.callback_query?.message?.chat?.id;
      if (chatId) await safeTelegram(this.env, "sendMessage", { chat_id: String(chatId), text: `❌ ${shortText(error?.message || error, 1000)}` });
    }
    return new Response("OK");
  }

  async handleHttp(request, url) {
    if (url.pathname === "/health") {
      const settings = this.getSettings();
      return new Response(JSON.stringify({
        ok: true,
        botConfigured: Boolean(getBotToken(this.env)),
        ownerConfigured: Boolean(getOwnerId(this.env)),
        botUsername: settings.bot_username || null,
        storageConfigured: Boolean(settings.storage_chat_id),
        ticketChannelConfigured: Boolean(settings.ticket_chat_id),
        requiredChannels: Number(this.first(`SELECT COUNT(*) AS count FROM channels WHERE active = 1`)?.count || 0),
        admins: Number(this.first(`SELECT COUNT(*) AS count FROM admins`)?.count || 0),
        users: Number(this.first(`SELECT COUNT(*) AS count FROM users`)?.count || 0),
        files: Number(this.first(`SELECT COUNT(*) AS count FROM files WHERE deleted = 0`)?.count || 0),
        alarm: await this.ctx.storage.getAlarm()
      }, null, 2), { headers: { "content-type": "application/json; charset=utf-8" } });
    }
    return new Response("Uploader Worker is running.");
  }

  async alarm() {
    try {
      await this.processBroadcasts();
    } catch (error) {
      const current = this.first(`SELECT id FROM broadcasts WHERE status = 'running' ORDER BY id ASC LIMIT 1`);
      if (current) this.ctx.storage.sql.exec(`UPDATE broadcasts SET last_error = ? WHERE id = ?`, String(error?.message || error).slice(0, 1000), Number(current.id));
      await this.scheduleAlarmSoon(CONFIG.BROADCAST_RETRY_MS);
    }
  }
}

async function setupBot(env, origin) {
  const secret = envValue(env, "WEBHOOK_SECRET", CONFIG.WEBHOOK_SECRET) || CONFIG.WEBHOOK_SECRET;
  const webhook = `${String(origin).replace(/\/$/, "")}/telegram`;
  await telegram(env, "setWebhook", {
    url: webhook,
    secret_token: secret || undefined,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
    max_connections: 40
  });
  const me = await telegram(env, "getMe");
  await telegram(env, "setMyCommands", {
    commands: [
      { command: "start", description: "Open uploader" },
      { command: "admin", description: "Open admin panel" },
      { command: "stats", description: "Show statistics" },
      { command: "users", description: "List users" },
      { command: "premium", description: "Buy Premium" },
      { command: "id", description: "Show Telegram ID" },
      { command: "cancel", description: "Cancel current action" }
    ]
  });
  await telegram(env, "setMyDescription", { description: "Fast Telegram file uploader with channels, referrals, premium and admin controls." });
  await telegram(env, "setMyShortDescription", { short_description: "Telegram File Uploader" });
  return { webhook, bot: me };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const id = env.UPLOADER.idFromName("main");
    const stub = env.UPLOADER.get(id);
    if (url.pathname === "/telegram") return stub.fetch(request);
    if (url.pathname === "/setup") {
      try {
        const configured = await setupBot(env, url.origin);
        await stub.setBotUsername(configured.bot?.username || "");
        return new Response(JSON.stringify({ ok: true, ...configured }, null, 2), { headers: { "content-type": "application/json; charset=utf-8" } });
      } catch (error) {
        return new Response(JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2), { status: 500, headers: { "content-type": "application/json; charset=utf-8" } });
      }
    }
    if (url.pathname === "/health") return stub.fetch(request);
    return new Response(JSON.stringify({ ok: true, service: "telegram-uploader", endpoints: { setup: "/setup", health: "/health", webhook: "/telegram" } }, null, 2), { headers: { "content-type": "application/json; charset=utf-8" } });
  }
};

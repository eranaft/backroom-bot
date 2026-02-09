export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") return new Response("", { status: 204, headers: cors() });

    // ---------- Public API for website ----------
    if (request.method === "GET" && url.pathname === "/state") {
      const st = await getLobby(env);
      return json(publicLobbyState(st), 200, cors());
    }

    if (request.method === "GET" && url.pathname === "/track/current") {
      const cur = await getCurrentTrack(env);
      return json(cur || { ok: false }, 200, cors());
    }

    if (request.method === "GET" && url.pathname === "/tracks") {
      const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") || 10)));
      const list = await getTracks(env);
      return json({ ok: true, items: list.slice(-limit).reverse() }, 200, cors());
    }

    // health
    if (request.method === "GET") {
      return new Response("OK", { status: 200, headers: cors() });
    }

    // ---------- Telegram webhook ----------
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: cors() });
    }

    const update = await request.json().catch(() => null);
    if (!update) return new Response("Bad JSON", { status: 400, headers: cors() });

    ctx.waitUntil(handleUpdate(update, env));
    return new Response("OK", { status: 200, headers: cors() });
  },
};

/* =========================
   Utils
========================= */
function cors() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store",
  };
}
function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}
function now() {
  return Date.now();
}
function isAdmin(env, id) {
  const admin = String(env.ADMIN_ID || "").trim();
  return admin && String(id) === admin;
}
async function tg(env, method, payload) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`${method} failed: ${JSON.stringify(data)}`);
  return data.result;
}

/* =========================
   KV Keys
========================= */
const LOBBY_KEY = "lobby:state"; // { openUntil:number(ms) }
const UI_KEY = (adminId) => `ui:${adminId}`; // { chatId, msgId, screen }
const PENDING_KEY = (adminId) => `pending:${adminId}`; // { type:"open_custom"|"rename_track", ... }
const STATS_KEY = "stats:global"; // { startsTotal, uniqueUsers, startsToday, dayStamp }
const SEEN_KEY = (userId) => `seen:${userId}`;
const TRACKS_KEY = "tracks:index"; // array of {id,title,url,createdAt,isPublic,isCurrent,durationSec?}
const CURRENT_TRACK_KEY = "tracks:current"; // trackId

/* =========================
   Lobby
========================= */
async function getLobby(env) {
  const raw = await env.KV.get(LOBBY_KEY);
  const st = raw ? JSON.parse(raw) : { openUntil: 0 };
  return { openUntil: Number(st.openUntil || 0) };
}
function lobbyIsOpen(st) {
  return Number(st.openUntil || 0) > now();
}
function fmtUntil(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mo} ${hh}:${mm}`;
}
function publicLobbyState(st) {
  const open = lobbyIsOpen(st);
  return {
    ok: true,
    isOpen: open,
    openUntil: st.openUntil || 0,
    // для твоего старого app.js совместимость:
    reopenAt: open ? null : (st.openUntil ? new Date(st.openUntil).toISOString() : null),
    windowId: open ? "OPEN" : "CLOSED",
    now: now(),
  };
}
async function setLobby(env, openUntil) {
  await env.KV.put(LOBBY_KEY, JSON.stringify({ openUntil: Number(openUntil || 0) }));
}

/* =========================
   Stats
========================= */
function dayStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
async function getStats(env) {
  const raw = await env.KV.get(STATS_KEY);
  const st = raw
    ? JSON.parse(raw)
    : { startsTotal: 0, uniqueUsers: 0, startsToday: 0, dayStamp: dayStamp() };

  const today = dayStamp();
  if (st.dayStamp !== today) {
    st.dayStamp = today;
    st.startsToday = 0;
  }
  return st;
}
async function bumpStatsOnStart(env, userId) {
  const st = await getStats(env);
  st.startsTotal += 1;
  st.startsToday += 1;

  const seen = await env.KV.get(SEEN_KEY(userId));
  if (!seen) {
    st.uniqueUsers += 1;
    await env.KV.put(SEEN_KEY(userId), "1");
  }
  await env.KV.put(STATS_KEY, JSON.stringify(st));
}

/* =========================
   Tracks (R2 + KV)
========================= */
function stripExt(name) {
  return String(name || "").replace(/\.[a-z0-9]+$/i, "");
}
function safeKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\-_ ]/gu, "")
    .replace(/\s+/g, "-")
    .slice(0, 60) || "track";
}
function guessExt(contentType, path) {
  const p = (path || "").toLowerCase();
  if (p.endsWith(".mp3") || contentType.includes("mpeg")) return ".mp3";
  if (p.endsWith(".wav") || contentType.includes("wav")) return ".wav";
  if (p.endsWith(".m4a") || contentType.includes("mp4")) return ".m4a";
  if (p.endsWith(".ogg") || contentType.includes("ogg")) return ".ogg";
  return "";
}

async function getTracks(env) {
  const raw = await env.KV.get(TRACKS_KEY);
  return raw ? JSON.parse(raw) : [];
}
async function putTracks(env, arr) {
  await env.KV.put(TRACKS_KEY, JSON.stringify(arr));
}
async function getCurrentTrack(env) {
  const tracks = await getTracks(env);
  const curId = await env.KV.get(CURRENT_TRACK_KEY);
  if (!curId) return tracks.slice().reverse().find((t) => t.isPublic) || null;
  return tracks.find((t) => t.id === curId) || null;
}
async function setCurrentTrack(env, trackId) {
  const tracks = await getTracks(env);
  let found = false;
  for (const t of tracks) {
    t.isCurrent = t.id === trackId;
    if (t.isCurrent) found = true;
  }
  if (found) {
    await env.KV.put(CURRENT_TRACK_KEY, trackId);
    await putTracks(env, tracks);
  }
  return found;
}

async function uploadTelegramAudioToR2(env, fileId, title) {
  const fileInfo = await tg(env, "getFile", { file_id: fileId });
  const path = fileInfo.file_path;
  const tgFileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${path}`;

  const res = await fetch(tgFileUrl);
  if (!res.ok) throw new Error("Failed to download from Telegram");

  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const ext = guessExt(contentType, path);
  const key = `tracks/${Date.now()}-${safeKey(title)}${ext}`;

  const bytes = await res.arrayBuffer();
  await env.R2.put(key, bytes, { httpMetadata: { contentType } });

  const base = String(env.R2_PUBLIC_BASE || "").replace(/\/+$/, "");
  const publicUrl = base ? `${base}/${key}` : key;

  return { key, publicUrl, contentType };
}

/* =========================
   Telegram UI
========================= */
function kbUser(env, open) {
  if (!open) {
    return { inline_keyboard: [[{ text: "🔒 Лобби закрыто", callback_data: "noop" }]] };
  }
  return { inline_keyboard: [[{ text: "🚪 Открыть BACKROOM", url: env.WEBAPP_URL }]] };
}

function kbAdminMain() {
  return {
    inline_keyboard: [
      [{ text: "🟢 Лобби", callback_data: "screen:lobby" }],
      [{ text: "🎵 Треки", callback_data: "screen:tracks" }],
      [{ text: "📊 Статистика", callback_data: "screen:stats" }],
      [{ text: "⚙️ Помощь", callback_data: "screen:help" }],
    ],
  };
}

function kbAdminBack() {
  return { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "screen:main" }]] };
}

function kbAdminLobby(st) {
  const open = lobbyIsOpen(st);
  return {
    inline_keyboard: [
      [
        { text: open ? "🔴 Закрыть" : "🟢 Открыть на 1 час", callback_data: open ? "lobby:close" : "lobby:open:3600" },
      ],
      [
        { text: "⏱ 15 минут", callback_data: "lobby:open:900" },
        { text: "⏱ 3 часа", callback_data: "lobby:open:10800" },
      ],
      [
        { text: "⏱ 12 часов", callback_data: "lobby:open:43200" },
        { text: "🕒 До конца дня", callback_data: "lobby:open:today" },
      ],
      [{ text: "✍️ Ввести минуты", callback_data: "lobby:open:custom" }],
      [{ text: "⬅️ Назад", callback_data: "screen:main" }],
    ],
  };
}

async function kbAdminTracks(env) {
  const cur = await getCurrentTrack(env);
  const curLine = cur ? `🎧 Сейчас: ${cur.title || cur.id}` : "🎧 Сейчас: —";
  return {
    inline_keyboard: [
      [{ text: "➕ Загрузить новый трек", callback_data: "track:upload" }],
      [{ text: "⭐ Сделать последнюю загрузку текущей", callback_data: "track:setlast" }],
      [{ text: "📜 Список (10)", callback_data: "track:list" }],
      [{ text: "⬅️ Назад", callback_data: "screen:main" }],
      [{ text: curLine, callback_data: "noop" }],
    ],
  };
}

/* =========================
   Render Admin in ONE message
========================= */
async function renderAdmin(env, adminId, chatId, screen, msgId = null) {
  const lobby = await getLobby(env);
  const open = lobbyIsOpen(lobby);

  let text = "Админ-панель BACKROOM 👇";
  let reply_markup = kbAdminMain();

  if (screen === "lobby") {
    text =
      `🟢 Лобби: ${open ? "ОТКРЫТО" : "ЗАКРЫТО"}\n` +
      `⏰ До: ${open ? fmtUntil(lobby.openUntil) : "—"}\n\n` +
      `Управление:`;
    reply_markup = kbAdminLobby(lobby);
  }

  if (screen === "tracks") {
    const cur = await getCurrentTrack(env);
    text =
      `🎵 Треки\n\n` +
      `🎧 Текущий на сайте: ${cur ? (cur.title || cur.id) : "—"}\n\n` +
      `Загрузка делается прямо сюда: пришли mp3/wav/m4a как Audio или File.`;
    reply_markup = await kbAdminTracks(env);
  }

  if (screen === "stats") {
    const stats = await getStats(env);
    text =
      `📊 Статистика\n\n` +
      `👤 Уникальных пользователей: ${stats.uniqueUsers}\n` +
      `▶️ /start всего: ${stats.startsTotal}\n` +
      `📅 /start сегодня: ${stats.startsToday}\n`;
    reply_markup = kbAdminBack();
  }

  if (screen === "help") {
    text =
      `⚙️ Помощь\n\n` +
      `• Лобби меняется кнопками в разделе "Лобби"\n` +
      `• Сайт каждые 1с читает /state у воркера\n` +
      `• Треки: загружаешь в боте → они появляются на сайте в плеере\n` +
      `• Меню не спамит — редактируется одно сообщение\n`;
    reply_markup = kbAdminBack();
  }

  // edit or send
  if (msgId) {
    await tg(env, "editMessageText", {
      chat_id: chatId,
      message_id: msgId,
      text,
      reply_markup,
    }).catch(async () => {
      const sent = await tg(env, "sendMessage", { chat_id: chatId, text, reply_markup });
      await env.KV.put(UI_KEY(adminId), JSON.stringify({ chatId, msgId: sent.message_id, screen }));
    });
  } else {
    const sent = await tg(env, "sendMessage", { chat_id: chatId, text, reply_markup });
    await env.KV.put(UI_KEY(adminId), JSON.stringify({ chatId, msgId: sent.message_id, screen }));
  }
}

/* =========================
   Main Update Handler
========================= */
async function handleUpdate(update, env) {
  const msg = update.message || update.edited_message;
  const cb = update.callback_query;

  // ---- callback buttons
  if (cb) {
    const fromId = cb.from?.id;
    const chatId = cb.message?.chat?.id;
    const msgId = cb.message?.message_id;
    const data = cb.data || "";

    await tg(env, "answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});

    if (data === "noop") return;

    // non-admin
    if (!isAdmin(env, fromId)) {
      const lobby = await getLobby(env);
      const open = lobbyIsOpen(lobby);
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: open ? "BACKROOM открыт 👇" : "Лобби сейчас закрыто 🔒",
        reply_markup: kbUser(env, open),
      });
      return;
    }

    // screens
    if (data.startsWith("screen:")) {
      const screen = data.split(":")[1] || "main";
      await env.KV.put(UI_KEY(fromId), JSON.stringify({ chatId, msgId, screen }));
      await renderAdmin(env, fromId, chatId, screen, msgId);
      return;
    }

    // lobby
    if (data === "lobby:close") {
      await setLobby(env, 0);
      await renderAdmin(env, fromId, chatId, "lobby", msgId);
      return;
    }

    if (data === "lobby:open:today") {
      const d = new Date();
      d.setHours(23, 59, 59, 999);
      await setLobby(env, d.getTime());
      await renderAdmin(env, fromId, chatId, "lobby", msgId);
      return;
    }

    if (data === "lobby:open:custom") {
      await env.KV.put(PENDING_KEY(fromId), JSON.stringify({ type: "open_custom", chatId, msgId }));
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "Напиши одним сообщением на сколько минут открыть (например: 45)",
      });
      return;
    }

    if (data.startsWith("lobby:open:")) {
      const sec = Number(data.split(":")[2] || 0);
      const openUntil = now() + sec * 1000;
      await setLobby(env, openUntil);
      await renderAdmin(env, fromId, chatId, "lobby", msgId);
      return;
    }

    // tracks
    if (data === "track:list") {
      const items = (await getTracks(env)).slice(-10).reverse();
      const text =
        items.length === 0
          ? "Пока треков нет."
          : items
              .map((t, i) => {
                const cur = t.isCurrent ? " ⭐CURRENT" : "";
                const pub = t.isPublic ? " PUBLIC" : " PRIVATE";
                return `${i + 1}) ${t.title || t.id}${cur}\n${t.url}\n${new Date(t.createdAt).toLocaleString()}${pub}`;
              })
              .join("\n\n");
      await tg(env, "sendMessage", { chat_id: chatId, text });
      return;
    }

    if (data === "track:setlast") {
      const arr = await getTracks(env);
      const last = arr[arr.length - 1];
      if (!last) {
        await tg(env, "sendMessage", { chat_id: chatId, text: "Нет треков." });
        return;
      }
      last.isPublic = true;
      await putTracks(env, arr);
      await setCurrentTrack(env, last.id);
      await renderAdmin(env, fromId, chatId, "tracks", msgId);
      return;
    }

    if (data === "track:upload") {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "Ок. Пришли аудиофайл (mp3/wav/m4a) как Audio или File. Название можешь написать в подписи.",
      });
      return;
    }

    return;
  }

  if (!msg) return;

  const chatId = msg.chat?.id;
  const fromId = msg.from?.id;
  const text = (msg.text || msg.caption || "").trim();

  // /start
  if ((msg.text || "").trim().startsWith("/start")) {
    await bumpStatsOnStart(env, fromId);

    if (isAdmin(env, fromId)) {
      const uiRaw = await env.KV.get(UI_KEY(fromId));
      const ui = uiRaw ? JSON.parse(uiRaw) : null;
      await renderAdmin(env, fromId, chatId, ui?.screen || "main", ui?.msgId || null);
      return;
    }

    const lobby = await getLobby(env);
    const open = lobbyIsOpen(lobby);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: open ? "BACKROOM 👇" : "Лобби закрыто 🔒",
      reply_markup: kbUser(env, open),
    });
    return;
  }

  // pending text input (admin)
  if (isAdmin(env, fromId) && msg.text) {
    const pendingRaw = await env.KV.get(PENDING_KEY(fromId));
    if (pendingRaw) {
      const p = JSON.parse(pendingRaw);
      await env.KV.delete(PENDING_KEY(fromId));

      if (p.type === "open_custom") {
        const minutes = Number((msg.text || "").trim());
        if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) {
          await tg(env, "sendMessage", { chat_id: chatId, text: "Нужно число минут (1..1440)." });
        } else {
          await setLobby(env, now() + minutes * 60 * 1000);
          await renderAdmin(env, fromId, p.chatId || chatId, "lobby", p.msgId || null);
        }
        return;
      }
    }
  }

  // admin: upload audio
  if (isAdmin(env, fromId)) {
    const file =
      msg.audio ||
      (msg.document && msg.document.mime_type?.startsWith("audio/") ? msg.document : null);

    if (file) {
      const title = (msg.caption || "").trim() || stripExt(file.file_name || "untitled");
      const up = await uploadTelegramAudioToR2(env, file.file_id, title);

      const track = {
        id: up.key,
        title,
        url: up.publicUrl,
        createdAt: now(),
        isPublic: true,
        isCurrent: false,
      };

      const arr = await getTracks(env);
      arr.push(track);
      await putTracks(env, arr);

      await setCurrentTrack(env, track.id);

      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: `✅ Залил и поставил текущим!\n\n🎵 ${track.title}\n${track.url}`,
      });

      const uiRaw = await env.KV.get(UI_KEY(fromId));
      const ui = uiRaw ? JSON.parse(uiRaw) : null;
      await renderAdmin(env, fromId, chatId, ui?.screen || "tracks", ui?.msgId || null);
      return;
    }
  }

  // non-admin: всегда показываем текущий статус
  if (!isAdmin(env, fromId)) {
    const lobby = await getLobby(env);
    const open = lobbyIsOpen(lobby);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: open ? "BACKROOM 👇" : "Лобби закрыто 🔒",
      reply_markup: kbUser(env, open),
    });
    return;
  }

  // admin: /admin или "меню"
  if ((msg.text || "").trim() === "/admin" || (msg.text || "").toLowerCase().includes("меню")) {
    const uiRaw = await env.KV.get(UI_KEY(fromId));
    const ui = uiRaw ? JSON.parse(uiRaw) : null;
    await renderAdmin(env, fromId, chatId, ui?.screen || "main", ui?.msgId || null);
    return;
  }

  // fallback admin
  const uiRaw = await env.KV.get(UI_KEY(fromId));
  const ui = uiRaw ? JSON.parse(uiRaw) : null;
  await renderAdmin(env, fromId, chatId, ui?.screen || "main", ui?.msgId || null);
}
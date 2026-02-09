// backroom-bot worker.js (Cloudflare Worker)
// ✅ Добавлено: GET /lobby (для сайта), OPTIONS (CORS), улучшена устойчивость к “слёту” переменных

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // -------- CORS preflight (на всякий случай) --------
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    // -------- API для сайта: статус лобби --------
    // GET https://<your-worker>.workers.dev/lobby  ->  { openUntil: number, open: boolean, now: number }
    if (request.method === "GET" && url.pathname === "/lobby") {
      const st = await getLobby(env);
      const open = lobbyIsOpen(st);
      return json(
        {
          openUntil: Number(st.openUntil || 0),
          open,
          now: Date.now(),
        },
        200
      );
    }

    // (опционально) хелсчек
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("OK", { status: 200 });
    }

    // -------- Telegram webhook --------
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const update = await request.json().catch(() => null);
    if (!update) return new Response("Bad JSON", { status: 400 });

    ctx.waitUntil(handleUpdate(update, env));
    return new Response("OK", { status: 200 });
  },
};

// ---------- helpers ----------
function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store",
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders() },
  });
}

function isAdmin(env, id) {
  const admin = String(env.ADMIN_ID || "").trim();
  return admin && String(id) === admin;
}

async function tg(env, method, payload) {
  const token = String(env.BOT_TOKEN || "").trim();
  if (!token) throw new Error("BOT_TOKEN is missing in env");

  const url = `https://api.telegram.org/bot${token}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`${method} failed: ${JSON.stringify(data)}`);
  return data.result;
}

// ---------- KV keys ----------
const LOBBY_KEY = "lobby:state"; // { openUntil:number (ms) }
const UI_KEY = (adminId) => `ui:${adminId}`; // { chatId, msgId, screen }
const STATS_KEY = "stats:global"; // { startsTotal, uniqueUsers, startsToday, dayStamp }
const SEEN_KEY = (userId) => `seen:${userId}`;

// ---------- Lobby helpers ----------
function now() {
  return Date.now();
}

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

// ---------- Keyboards ----------
function kbUser(env, lobbyOpen) {
  if (!lobbyOpen) {
    return { inline_keyboard: [[{ text: "🔒 Лобби закрыто", callback_data: "noop" }]] };
  }
  const web = String(env.WEBAPP_URL || "").trim();
  return { inline_keyboard: [[{ text: "🚪 Открыть BACKROOM", url: web }]] };
}

function kbAdminMain() {
  return {
    inline_keyboard: [
      [{ text: "🟢 Лобби: управление", callback_data: "screen:lobby" }],
      [{ text: "📊 Статистика", callback_data: "screen:stats" }],
      [{ text: "⚙️ Помощь", callback_data: "screen:help" }],
    ],
  };
}

function kbAdminLobby(st) {
  const open = lobbyIsOpen(st);
  return {
    inline_keyboard: [
      [
        {
          text: open ? "🔴 Закрыть лобби" : "🟢 Открыть лобби",
          callback_data: open ? "lobby:close" : "lobby:open:900",
        },
      ],
      [{ text: "⏱ Открыть на 15 мин", callback_data: "lobby:open:900" }],
      [{ text: "⏱ Открыть на 1 час", callback_data: "lobby:open:3600" }],
      [{ text: "⏱ Открыть на 3 часа", callback_data: "lobby:open:10800" }],
      [{ text: "⏱ Открыть на 12 часов", callback_data: "lobby:open:43200" }],
      [{ text: "⬅️ Назад", callback_data: "screen:main" }],
    ],
  };
}

function kbAdminBack() {
  return { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "screen:main" }]] };
}

// ---------- UI rendering ----------
async function renderAdmin(env, adminId, chatId, screen, msgId = null) {
  const lobby = await getLobby(env);
  const open = lobbyIsOpen(lobby);

  let text = "Админ-панель BACKROOM 👇";
  let reply_markup = kbAdminMain();

  if (screen === "lobby") {
    text =
      `🟢 Лобби: ${open ? "ОТКРЫТО" : "ЗАКРЫТО"}\n` +
      `⏰ До: ${open ? fmtUntil(lobby.openUntil) : "—"}\n\n` +
      `Выбери действие:`;
    reply_markup = kbAdminLobby(lobby);
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
      `• Лобби открывается на время кнопками\n` +
      `• Пользователи видят кнопку входа только когда лобби открыто\n` +
      `• Меню не спамит — редактируется одно сообщение\n\n` +
      `Проверка API для сайта: /lobby`;
    reply_markup = kbAdminBack();
  }

  // if have msgId -> edit, else send
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

// ---------- Stats ----------
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

// ---------- Update handler ----------
async function handleUpdate(update, env) {
  const msg = update.message || update.edited_message;
  const cb = update.callback_query;

  if (cb) {
    const fromId = cb.from?.id;
    const chatId = cb.message?.chat?.id;
    const msgId = cb.message?.message_id;
    const data = cb.data || "";

    await tg(env, "answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});

    // no-op for users
    if (data === "noop") return;

    // Admin only
    if (!isAdmin(env, fromId)) {
      const lobby = await getLobby(env);
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: lobbyIsOpen(lobby) ? "BACKROOM открыт 👇" : "Лобби сейчас закрыто 🔒",
        reply_markup: kbUser(env, lobbyIsOpen(lobby)),
      });
      return;
    }

    // screen navigation
    if (data.startsWith("screen:")) {
      const screen = data.split(":")[1] || "main";
      await env.KV.put(UI_KEY(fromId), JSON.stringify({ chatId, msgId, screen }));
      await renderAdmin(env, fromId, chatId, screen, msgId);
      return;
    }

    // lobby actions
    if (data === "lobby:close") {
      await env.KV.put(LOBBY_KEY, JSON.stringify({ openUntil: 0 }));
      await renderAdmin(env, fromId, chatId, "lobby", msgId);
      return;
    }

    if (data.startsWith("lobby:open:")) {
      const sec = Number(data.split(":")[2] || 0);
      const openUntil = now() + sec * 1000;
      await env.KV.put(LOBBY_KEY, JSON.stringify({ openUntil }));
      await renderAdmin(env, fromId, chatId, "lobby", msgId);
      return;
    }

    return;
  }

  if (!msg) return;

  const chatId = msg.chat?.id;
  const fromId = msg.from?.id;
  const text = (msg.text || "").trim();

  // /start stats
  if (text.startsWith("/start")) {
    await bumpStatsOnStart(env, fromId);

    if (isAdmin(env, fromId)) {
      // reuse last admin message if exists
      const uiRaw = await env.KV.get(UI_KEY(fromId));
      const ui = uiRaw ? JSON.parse(uiRaw) : null;

      // if already have panel message -> edit it, else send new
      await renderAdmin(env, fromId, chatId, ui?.screen || "main", ui?.msgId || null);
      return;
    }

    const lobby = await getLobby(env);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: lobbyIsOpen(lobby) ? "BACKROOM 👇" : "Лобби закрыто 🔒",
      reply_markup: kbUser(env, lobbyIsOpen(lobby)),
    });
    return;
  }

  // Non-admin: always show current state
  if (!isAdmin(env, fromId)) {
    const lobby = await getLobby(env);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: lobbyIsOpen(lobby) ? "BACKROOM 👇" : "Лобби закрыто 🔒",
      reply_markup: kbUser(env, lobbyIsOpen(lobby)),
    });
    return;
  }

  // Admin: if пишет "меню" — открыть панель
  if (text.toLowerCase().includes("меню") || text === "/admin") {
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
/**
 * BACKROOM BOT CMS (Cloudflare Workers)
 * ----------------------------------------------------
 * Bindings:
 *  - env.KV  (KV Namespace)
 *  - env.R2  (R2 Bucket)
 *
 * Secrets/Vars:
 *  - BOT_TOKEN       (secret)
 *  - ADMIN_ID        (secret or var)
 *  - WEBAPP_URL      (var)  - ссылка на BACKROOM web
 *  - R2_PUBLIC_BASE  (var)  - например https://pub-xxxx.r2.dev
 *
 * Optional:
 *  - BOT_USERNAME (var) - не обязательно
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- Public endpoints for your webapp ---
    if (request.method === "GET" && url.pathname === "/status") {
      const st = await getLobbyStatus(env);
      return json(
        {
          ok: true,
          open: st.open,
          open_until: st.openUntil,
          now: Date.now(),
        },
        {
          "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
        }
      );
    }

    // web analytics ping (call from lobby on page load)
    // example: fetch(`${WORKER}/hit?path=/lobby`, { method:"POST" })
    if (url.pathname === "/hit" && request.method === "POST") {
      // no auth needed; extremely simple analytics
      const ip =
        request.headers.get("cf-connecting-ip") ||
        request.headers.get("x-forwarded-for") ||
        "0.0.0.0";
      const ua = request.headers.get("user-agent") || "";
      const body = await request.json().catch(() => ({}));
      const path = String(body.path || url.searchParams.get("path") || "/");
      ctx.waitUntil(trackWebHit(env, { ip, ua, path }));
      return json({ ok: true });
    }

    // health check
    if (request.method === "GET") return new Response("OK", { status: 200 });

    // Telegram webhook must be POST
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const update = await request.json().catch(() => null);
    if (!update) return new Response("Bad JSON", { status: 400 });

    ctx.waitUntil(handleUpdate(update, env));
    return new Response("OK", { status: 200 });
  },
};

// ----------------- KV Keys -----------------
const KEY = {
  lobby: "lobby:open_until",
  adminPanel: (adminId) => `admin:panel:${adminId}`, // {chat_id, message_id}
  state: (adminId) => `admin:state:${adminId}`, // FSM for track upload/edit
  tracksIndex: "tracks:index", // array of track ids
  track: (id) => `track:${id}`, // track object json
  metricsDay: (day) => `metrics:${day}`, // day metrics
  tgUserSeen: (id) => `tguser:${id}`, // firstSeen stamp
  webSeen: (hash) => `webseen:${hash}`, // firstSeen stamp
};

// ----------------- Helpers -----------------
function json(obj, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function isAdmin(env, fromId) {
  const admin = Number(env.ADMIN_ID || 0);
  return admin && Number(fromId) === admin;
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

function fmtTs(ts) {
  if (!ts || ts <= 0) return "—";
  const d = new Date(ts);
  return d.toLocaleString("ru-RU", { hour12: false });
}

function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function safeKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\-_ ]/gu, "")
    .replace(/\s+/g, "-")
    .slice(0, 70) || "track";
}

function stripExt(name) {
  return String(name || "").replace(/\.[a-z0-9]+$/i, "");
}

function guessExt(contentType, path) {
  const p = (path || "").toLowerCase();
  if (p.endsWith(".mp3") || contentType.includes("mpeg")) return ".mp3";
  if (p.endsWith(".wav") || contentType.includes("wav")) return ".wav";
  if (p.endsWith(".m4a") || contentType.includes("mp4")) return ".m4a";
  if (p.endsWith(".ogg") || contentType.includes("ogg")) return ".ogg";
  return "";
}

function parseChapters(text) {
  // формат:
  // 00:00 интро
  // 01:23 куплет
  // 02:10 припев
  // или 0:35 blah
  const lines = String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const out = [];
  for (const l of lines) {
    const m = l.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s+(.+)$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    const c = m[3] ? Number(m[3]) : null;
    const name = m[4].trim();
    const seconds = c != null ? a * 3600 + b * 60 + c : a * 60 + b;
    out.push({ t: seconds, title: name });
  }
  out.sort((x, y) => x.t - y.t);
  return out;
}

function kbUser(env) {
  return {
    inline_keyboard: [[{ text: "Открыть BACKROOM", url: env.WEBAPP_URL }]],
  };
}

// ----------------- Lobby status -----------------
async function getLobbyStatus(env) {
  const raw = await env.KV.get(KEY.lobby);
  const openUntil = raw ? Number(raw) : 0;
  const now = Date.now();
  return {
    openUntil,
    open: openUntil === -1 || openUntil > now,
  };
}

async function setLobbyOpenUntil(env, until) {
  await env.KV.put(KEY.lobby, String(until));
}

// ----------------- Metrics -----------------
async function metricInc(env, field, amount = 1) {
  const dk = dayKey();
  const key = KEY.metricsDay(dk);
  const raw = await env.KV.get(key);
  const obj = raw ? JSON.parse(raw) : {};
  obj[field] = (obj[field] || 0) + amount;
  obj.updatedAt = Date.now();
  await env.KV.put(key, JSON.stringify(obj));
}

async function trackTgUser(env, userId) {
  const k = KEY.tgUserSeen(userId);
  const exists = await env.KV.get(k);
  if (!exists) {
    await env.KV.put(k, String(Date.now()));
    await metricInc(env, "tg_unique_users", 1);
  }
}

async function hashLite(s) {
  // легкий хэш без крипто (нам не нужна безопасность, просто уникальность)
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

async function trackWebHit(env, { ip, ua, path }) {
  await metricInc(env, "web_hits", 1);
  const dk = dayKey();
  await metricInc(env, `web_hits_${dk}`, 1);

  const id = await hashLite(`${ip}|${ua}`); // грубо как уникальный посетитель
  const seenKey = KEY.webSeen(id);
  const exists = await env.KV.get(seenKey);
  if (!exists) {
    await env.KV.put(seenKey, String(Date.now()));
    await metricInc(env, "web_unique_users", 1);
  }

  // топ путей (очень просто)
  const topKey = `web:path:${dk}:${path}`;
  const raw = await env.KV.get(topKey);
  const n = raw ? Number(raw) : 0;
  await env.KV.put(topKey, String(n + 1));
}

// ----------------- Admin Panel UI -----------------
function screenTitle(title) {
  return `🕳️ BACKROOM • CMS\n\n*${title}*\n`;
}

async function renderMainMenu(env) {
  const st = await getLobbyStatus(env);
  const statusLine = st.open
    ? `🟢 Лобби: *OPEN* ${st.openUntil === -1 ? "(навсегда)" : `до ${fmtTs(st.openUntil)}`}`
    : `🔴 Лобби: *CLOSED*`;

  return (
    screenTitle("Админ-панель") +
    statusLine +
    `\n\nВыбирай раздел:`
  );
}

function kbMain() {
  return {
    inline_keyboard: [
      [{ text: "🟢/🔴 Лобби", callback_data: "nav:lobby" }],
      [{ text: "🎵 Треки", callback_data: "nav:tracks" }],
      [{ text: "📊 Аналитика", callback_data: "nav:stats" }],
      [{ text: "⚙️ Настройки", callback_data: "nav:settings" }],
      [{ text: "❓ Помощь", callback_data: "nav:help" }],
    ],
  };
}

async function renderLobbyMenu(env) {
  const st = await getLobbyStatus(env);
  const statusLine = st.open
    ? `🟢 Лобби: *OPEN* ${st.openUntil === -1 ? "(навсегда)" : `до ${fmtTs(st.openUntil)}`}`
    : `🔴 Лобби: *CLOSED*`;

  return (
    screenTitle("Лобби") +
    statusLine +
    `\n\nВыбери действие:`
  );
}

function kbLobby() {
  return {
    inline_keyboard: [
      [
        { text: "Открыть 15 мин", callback_data: "lobby:open:15m" },
        { text: "Открыть 1 час", callback_data: "lobby:open:1h" },
      ],
      [
        { text: "Открыть 6 часов", callback_data: "lobby:open:6h" },
        { text: "Открыть 24 часа", callback_data: "lobby:open:24h" },
      ],
      [{ text: "Открыть навсегда", callback_data: "lobby:open:forever" }],
      [{ text: "🔴 Закрыть сейчас", callback_data: "lobby:close" }],
      [{ text: "⬅️ Назад", callback_data: "nav:main" }],
    ],
  };
}

async function renderTracksMenu(env) {
  return (
    screenTitle("Треки") +
    `Выбери действие:`
  );
}

function kbTracks() {
  return {
    inline_keyboard: [
      [{ text: "➕ Загрузить черновик", callback_data: "trk:upload:draft" }],
      [{ text: "🚀 Загрузить и опубликовать", callback_data: "trk:upload:public" }],
      [{ text: "📜 Список треков", callback_data: "trk:list" }],
      [{ text: "⬅️ Назад", callback_data: "nav:main" }],
    ],
  };
}

async function renderStatsMenu(env) {
  const dk = dayKey();
  const raw = await env.KV.get(KEY.metricsDay(dk));
  const m = raw ? JSON.parse(raw) : {};

  const lines = [
    `📅 День (UTC): *${dk}*`,
    ``,
    `TG:`,
    `• Сообщения/ивенты: *${m.tg_events || 0}*`,
    `• Уникальные пользователи: *${m.tg_unique_users || 0}*`,
    ``,
    `WEB:`,
    `• Хиты: *${m.web_hits || 0}*`,
    `• Уникальные: *${m.web_unique_users || 0}*`,
  ];

  return screenTitle("Аналитика") + lines.join("\n");
}

function kbStats() {
  return {
    inline_keyboard: [
      [{ text: "🔄 Обновить", callback_data: "nav:stats" }],
      [{ text: "⬅️ Назад", callback_data: "nav:main" }],
    ],
  };
}

async function renderSettingsMenu(env) {
  const st = await getLobbyStatus(env);
  return (
    screenTitle("Настройки") +
    `WEBAPP_URL: \`${env.WEBAPP_URL || "—"}\`\n` +
    `R2_PUBLIC_BASE: \`${env.R2_PUBLIC_BASE || "—"}\`\n` +
    `Лобби сейчас: *${st.open ? "OPEN" : "CLOSED"}*`
  );
}

function kbSettings() {
  return {
    inline_keyboard: [
      [{ text: "⬅️ Назад", callback_data: "nav:main" }],
    ],
  };
}

async function renderHelpMenu() {
  return (
    screenTitle("Помощь") +
    `*Как пользоваться*\n\n` +
    `1) Лобби → открываешь на время или закрываешь.\n` +
    `2) Треки → нажимаешь загрузку и отправляешь аудиофайл.\n` +
    `3) Таймкоды → после заливки можно прислать списком вида:\n` +
    `\`00:00 Интро\n01:12 Куплет\n02:05 Припев\`\n\n` +
    `Пользователи видят только кнопку “Открыть BACKROOM”.`
  );
}

function kbHelp() {
  return {
    inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "nav:main" }]],
  };
}

async function upsertAdminPanel(env, chatId, adminId, text, keyboard) {
  // Стараемся редактировать одно и то же сообщение, чтобы “панель” не плодилась.
  const savedRaw = await env.KV.get(KEY.adminPanel(adminId));
  const saved = savedRaw ? JSON.parse(savedRaw) : null;

  if (saved?.chat_id === chatId && saved?.message_id) {
    // try edit
    const ok = await tg(env, "editMessageText", {
      chat_id: chatId,
      message_id: saved.message_id,
      text,
      parse_mode: "Markdown",
      reply_markup: keyboard,
      disable_web_page_preview: true,
    }).catch(() => null);

    if (ok) return;
  }

  // fallback: send new + save
  const sent = await tg(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    reply_markup: keyboard,
    disable_web_page_preview: true,
  });

  await env.KV.put(
    KEY.adminPanel(adminId),
    JSON.stringify({ chat_id: chatId, message_id: sent.message_id })
  );
}

async function showAdminScreen(env, chatId, adminId, screen) {
  // screen: main | lobby | tracks | stats | settings | help
  if (screen === "main") {
    return upsertAdminPanel(env, chatId, adminId, await renderMainMenu(env), kbMain());
  }
  if (screen === "lobby") {
    return upsertAdminPanel(env, chatId, adminId, await renderLobbyMenu(env), kbLobby());
  }
  if (screen === "tracks") {
    return upsertAdminPanel(env, chatId, adminId, await renderTracksMenu(env), kbTracks());
  }
  if (screen === "stats") {
    return upsertAdminPanel(env, chatId, adminId, await renderStatsMenu(env), kbStats());
  }
  if (screen === "settings") {
    return upsertAdminPanel(env, chatId, adminId, await renderSettingsMenu(env), kbSettings());
  }
  if (screen === "help") {
    return upsertAdminPanel(env, chatId, adminId, await renderHelpMenu(), kbHelp());
  }
}

// ----------------- Track storage -----------------
async function getTracksIndex(env) {
  const raw = await env.KV.get(KEY.tracksIndex);
  return raw ? JSON.parse(raw) : [];
}

async function setTracksIndex(env, arr) {
  await env.KV.put(KEY.tracksIndex, JSON.stringify(arr));
}

async function saveTrack(env, track) {
  await env.KV.put(KEY.track(track.id), JSON.stringify(track));
}

async function loadTrack(env, id) {
  const raw = await env.KV.get(KEY.track(id));
  return raw ? JSON.parse(raw) : null;
}

function trackPublicUrl(env, key) {
  const base = String(env.R2_PUBLIC_BASE || "").replace(/\/+$/, "");
  return base ? `${base}/${key}` : key;
}

// ----------------- Telegram update handler -----------------
async function handleUpdate(update, env) {
  const msg = update.message || update.edited_message;
  const cb = update.callback_query;

  // metrics
  await metricInc(env, "tg_events", 1).catch(() => {});

  if (cb) {
    const fromId = cb.from?.id;
    const chatId = cb.message?.chat?.id;
    const data = cb.data || "";

    await tg(env, "answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});
    await trackTgUser(env, fromId).catch(() => {});

    // non-admin: show only open button
    if (!isAdmin(env, fromId)) {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "BACKROOM 👇",
        reply_markup: kbUser(env),
      });
      return;
    }

    // NAV
    if (data.startsWith("nav:")) {
      const screen = data.split(":")[1];
      const map = {
        main: "main",
        lobby: "lobby",
        tracks: "tracks",
        stats: "stats",
        settings: "settings",
        help: "help",
      };
      await showAdminScreen(env, chatId, fromId, map[screen] || "main");
      return;
    }

    // LOBBY actions
    if (data.startsWith("lobby:")) {
      const parts = data.split(":"); // lobby:open:15m
      const action = parts[1];

      if (action === "close") {
        await setLobbyOpenUntil(env, 0);
        await showAdminScreen(env, chatId, fromId, "lobby");
        return;
      }

      if (action === "open") {
        const param = parts[2];
        let until = Date.now();

        if (param === "forever") until = -1;
        else if (param === "15m") until += 15 * 60 * 1000;
        else if (param === "1h") until += 60 * 60 * 1000;
        else if (param === "6h") until += 6 * 60 * 60 * 1000;
        else if (param === "24h") until += 24 * 60 * 60 * 1000;
        else until += 15 * 60 * 1000;

        await setLobbyOpenUntil(env, until);
        await showAdminScreen(env, chatId, fromId, "lobby");
        return;
      }
    }

    // TRACK actions
    if (data.startsWith("trk:")) {
      const parts = data.split(":");
      const action = parts[1];

      if (action === "upload") {
        const mode = parts[2]; // draft | public
        await env.KV.put(KEY.state(fromId), JSON.stringify({ mode: "upload", visibility: mode }));
        await upsertAdminPanel(
          env,
          chatId,
          fromId,
          screenTitle("Загрузка трека") +
            `Ок. Пришли *аудиофайл* (mp3/wav/m4a/ogg) как *аудио* или *файл*.\n\n` +
            `Статус: *${mode.toUpperCase()}*\n` +
            `Можно в подписи (caption) указать название.\n\n` +
            `После заливки я предложу добавить *таймкоды* и *описание*.`,
          {
            inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "nav:tracks" }]],
          }
        );
        return;
      }

      if (action === "list") {
        const ids = await getTracksIndex(env);
        if (!ids.length) {
          await upsertAdminPanel(env, chatId, fromId, screenTitle("Список треков") + `Пока пусто.`, {
            inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "nav:tracks" }]],
          });
          return;
        }

        // последние 10
        const last = ids.slice(-10).reverse();
        const lines = [];
        const kb = [];
        for (const id of last) {
          const t = await loadTrack(env, id);
          if (!t) continue;
          lines.push(`• *${t.title}* — ${t.status} (${fmtTs(t.createdAt)})`);
          kb.push([{ text: `✏️ ${t.title}`, callback_data: `trk:edit:${t.id}` }]);
        }
        kb.push([{ text: "⬅️ Назад", callback_data: "nav:tracks" }]);

        await upsertAdminPanel(
          env,
          chatId,
          fromId,
          screenTitle("Список треков") + lines.join("\n"),
          { inline_keyboard: kb }
        );
        return;
      }

      if (action === "edit") {
        const id = parts[2];
        const t = await loadTrack(env, id);
        if (!t) {
          await tg(env, "sendMessage", { chat_id: chatId, text: "Трек не найден." });
          return;
        }

        await env.KV.put(KEY.state(fromId), JSON.stringify({ mode: "edit", trackId: id }));
        const txt =
          screenTitle("Редактор трека") +
          `*${t.title}*\n` +
          `Status: *${t.status}*\n` +
          `URL: ${t.url}\n\n` +
          `Описание: ${t.desc ? "✅ есть" : "—"}\n` +
          `Таймкоды: ${t.chapters?.length ? `✅ ${t.chapters.length} шт` : "—"}\n\n` +
          `Выбери что менять:`;

        await upsertAdminPanel(env, chatId, fromId, txt, {
          inline_keyboard: [
            [{ text: "📝 Изменить описание", callback_data: `trk:setdesc:${id}` }],
            [{ text: "⏱ Добавить таймкоды", callback_data: `trk:setchap:${id}` }],
            [{ text: "🔄 Переключить draft/public", callback_data: `trk:toggle:${id}` }],
            [{ text: "⬅️ Назад к списку", callback_data: "trk:list" }],
          ],
        });
        return;
      }

      if (action === "toggle") {
        const id = parts[2];
        const t = await loadTrack(env, id);
        if (!t) return;
        t.status = t.status === "public" ? "draft" : "public";
        await saveTrack(env, t);
        await showAdminScreen(env, chatId, fromId, "tracks");
        await tg(env, "sendMessage", {
          chat_id: chatId,
          text: `Готово: *${t.title}* теперь *${t.status}*`,
          parse_mode: "Markdown",
        });
        return;
      }

      if (action === "setdesc") {
        const id = parts[2];
        await env.KV.put(KEY.state(fromId), JSON.stringify({ mode: "setdesc", trackId: id }));
        await upsertAdminPanel(
          env,
          chatId,
          fromId,
          screenTitle("Описание") + `Пришли одним сообщением *описание* для трека.`,
          { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: `trk:edit:${id}` }]] }
        );
        return;
      }

      if (action === "setchap") {
        const id = parts[2];
        await env.KV.put(KEY.state(fromId), JSON.stringify({ mode: "setchap", trackId: id }));
        await upsertAdminPanel(
          env,
          chatId,
          fromId,
          screenTitle("Таймкоды") +
            `Пришли таймкоды списком:\n\n` +
            `\`00:00 Интро\n01:12 Куплет\n02:05 Припев\`\n\n` +
            `Поддержка: mm:ss или hh:mm:ss`,
          { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: `trk:edit:${id}` }]] }
        );
        return;
      }
    }

    // unknown callback -> go main
    await showAdminScreen(env, chatId, fromId, "main");
    return;
  }

  if (!msg) return;

  const chatId = msg.chat?.id;
  const fromId = msg.from?.id;
  const text = msg.text || msg.caption || "";

  await trackTgUser(env, fromId).catch(() => {});

  // /start or /menu
  if (text.startsWith("/start") || text.startsWith("/menu")) {
    if (isAdmin(env, fromId)) {
      await showAdminScreen(env, chatId, fromId, "main");
    } else {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "BACKROOM 👇",
        reply_markup: kbUser(env),
      });
    }
    return;
  }

  // non-admin: always only button
  if (!isAdmin(env, fromId)) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "BACKROOM 👇",
      reply_markup: kbUser(env),
    });
    return;
  }

  // admin: check state machine
  const stateRaw = await env.KV.get(KEY.state(fromId));
  const state = stateRaw ? JSON.parse(stateRaw) : null;

  // file upload
  const file =
    msg.audio ||
    (msg.document && msg.document.mime_type?.startsWith("audio/") ? msg.document : null);

  if (state?.mode === "upload" && file) {
    const titleFromCaption = (msg.caption || "").trim();
    const title = titleFromCaption || (file.file_name ? stripExt(file.file_name) : "untitled");

    const uploaded = await uploadTelegramFileToR2(env, file.file_id, title);
    const status = state.visibility === "public" ? "public" : "draft";

    const track = {
      id: uploaded.key,
      title,
      status,
      url: uploaded.publicUrl,
      createdAt: Date.now(),
      desc: "",
      chapters: [],
    };

    // persist
    await saveTrack(env, track);
    const index = await getTracksIndex(env);
    index.push(track.id);
    await setTracksIndex(env, index);

    await env.KV.put(KEY.state(fromId), JSON.stringify({ mode: "edit", trackId: track.id }));

    // show editor
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text:
        `✅ Залил!\n\n` +
        `• *${track.title}*\n` +
        `• Status: *${track.status}*\n` +
        `• URL: ${track.url}\n\n` +
        `Сейчас можно добавить описание и таймкоды.`,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });

    await upsertAdminPanel(env, chatId, fromId, await renderTracksMenu(env), kbTracks());
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `Открываю редактор трека 👇`,
      reply_markup: {
        inline_keyboard: [[{ text: "✏️ Редактировать", callback_data: `trk:edit:${track.id}` }]],
      },
    });

    return;
  }

  // set description
  if (state?.mode === "setdesc" && text) {
    const t = await loadTrack(env, state.trackId);
    if (!t) return;
    t.desc = String(text).trim();
    await saveTrack(env, t);
    await env.KV.put(KEY.state(fromId), JSON.stringify({ mode: "edit", trackId: t.id }));
    await tg(env, "sendMessage", { chat_id: chatId, text: "✅ Описание сохранено." });
    await showAdminScreen(env, chatId, fromId, "tracks");
    return;
  }

  // set chapters
  if (state?.mode === "setchap" && text) {
    const t = await loadTrack(env, state.trackId);
    if (!t) return;
    const chapters = parseChapters(text);
    t.chapters = chapters;
    await saveTrack(env, t);
    await env.KV.put(KEY.state(fromId), JSON.stringify({ mode: "edit", trackId: t.id }));
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: chapters.length ? `✅ Таймкоды сохранены: ${chapters.length} шт.` : "Я не нашёл таймкоды. Формат: 01:23 Название",
    });
    await showAdminScreen(env, chatId, fromId, "tracks");
    return;
  }

  // fallback: just show admin menu again
  await showAdminScreen(env, chatId, fromId, "main");
}

// ----------------- Telegram -> R2 upload -----------------
async function uploadTelegramFileToR2(env, fileId, title) {
  const fileInfo = await tg(env, "getFile", { file_id: fileId });
  const path = fileInfo.file_path;
  const tgFileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${path}`;

  const res = await fetch(tgFileUrl);
  if (!res.ok) throw new Error("Failed to download file from Telegram");

  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const ext = guessExt(contentType, path);
  const key = `tracks/${Date.now()}-${safeKey(title)}${ext}`;

  const bytes = await res.arrayBuffer();
  await env.R2.put(key, bytes, { httpMetadata: { contentType } });

  return { key, publicUrl: trackPublicUrl(env, key) };
}
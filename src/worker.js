export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET") {
      return new Response("OK", { status: 200 });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const update = await request.json().catch(() => null);
    if (!update) return new Response("Bad JSON", { status: 400 });

    ctx.waitUntil(handleUpdate(update, env));
    return new Response("OK", { status: 200 });
  },
};

function isAdmin(env, chatIdOrFromId) {
  const admin = Number(env.ADMIN_ID || 0);
  return admin && Number(chatIdOrFromId) === admin;
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

function kbUser(env) {
  return {
    inline_keyboard: [[{ text: "Открыть BACKROOM", url: env.WEBAPP_URL }]],
  };
}

function kbAdmin() {
  return {
    inline_keyboard: [
      [{ text: "➕ Загрузить (черновик)", callback_data: "up:draft" }],
      [{ text: "🚀 Опубликовать", callback_data: "up:pub" }],
      [{ text: "📜 Список треков", callback_data: "list" }],
      [{ text: "⚙️ Помощь", callback_data: "help" }],
    ],
  };
}

// --------- CMS state keys ----------
const STATE_KEY = (id) => `state:${id}`;
const TRACKS_KEY = "tracks:index"; // JSON array of {id,title,status,...}

async function handleUpdate(update, env) {
  const msg = update.message || update.edited_message;
  const cb = update.callback_query;

  if (cb) {
    const fromId = cb.from?.id;
    const chatId = cb.message?.chat?.id;
    const data = cb.data || "";

    // always answer callback to remove "loading"
    await tg(env, "answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});

    if (!isAdmin(env, fromId)) {
      // non-admin only gets open button
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "BACKROOM 👇",
        reply_markup: kbUser(env),
      });
      return;
    }

    if (data === "up:draft") {
      await env.KV.put(STATE_KEY(fromId), JSON.stringify({ mode: "draft" }));
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "Ок. Пришли мне *аудиофайл* (mp3/wav) как файл или аудио. Я залью в R2 как *черновик*.\n\nМожно сразу подписью написать название трека.",
        parse_mode: "Markdown",
      });
      return;
    }

    if (data === "up:pub") {
      await env.KV.put(STATE_KEY(fromId), JSON.stringify({ mode: "pub" }));
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "Ок. Пришли аудиофайл — я залью и сразу помечу как *public*.",
        parse_mode: "Markdown",
      });
      return;
    }

    if (data === "list") {
      const raw = await env.KV.get(TRACKS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      if (!arr.length) {
        await tg(env, "sendMessage", { chat_id: chatId, text: "Пока пусто." });
        return;
      }
      const text = arr
        .slice(-20)
        .reverse()
        .map((t, i) => `${i + 1}) ${t.title || t.id} — ${t.status} \n${t.url}`)
        .join("\n\n");
      await tg(env, "sendMessage", { chat_id: chatId, text });
      return;
    }

    if (data === "help") {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text:
          "Админ-команды:\n" +
          "• Нажми «Загрузить (черновик)» или «Опубликовать»\n" +
          "• Пришли аудиофайл\n" +
          "• Я залью в R2 и добавлю в список\n\n" +
          "Пользователи видят только кнопку «Открыть BACKROOM».",
      });
      return;
    }

    return;
  }

  if (!msg) return;

  const chatId = msg.chat?.id;
  const fromId = msg.from?.id;
  const text = msg.text || msg.caption || "";

  // start / menu
  if (text.startsWith("/start") || text.toLowerCase().includes("меню")) {
    if (isAdmin(env, fromId)) {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "Админ-панель BACKROOM 👇",
        reply_markup: kbAdmin(),
      });
    } else {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "BACKROOM 👇",
        reply_markup: kbUser(env),
      });
    }
    return;
  }

  // non-admin: always only open button
  if (!isAdmin(env, fromId)) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "BACKROOM 👇",
      reply_markup: kbUser(env),
    });
    return;
  }

  // admin: handle audio/doc upload if state is set
  const stateRaw = await env.KV.get(STATE_KEY(fromId));
  const state = stateRaw ? JSON.parse(stateRaw) : null;

  const file =
    msg.audio ||
    (msg.document && msg.document.mime_type?.startsWith("audio/") ? msg.document : null);

  if (file && state?.mode) {
    const titleFromCaption = (msg.caption || "").trim();
    const title = titleFromCaption || (file.file_name ? stripExt(file.file_name) : "untitled");

    const uploaded = await uploadTelegramFileToR2(env, file.file_id, title);

    const status = state.mode === "pub" ? "public" : "draft";
    const track = {
      id: uploaded.key,
      title,
      status,
      url: uploaded.publicUrl,
      createdAt: Date.now(),
    };

    await addToIndex(env, track);

    await env.KV.delete(STATE_KEY(fromId));

    await tg(env, "sendMessage", {
      chat_id: chatId,
      text:
        `✅ Принял и залил!\n` +
        `• Title: ${track.title}\n` +
        `• Status: ${track.status}\n` +
        `• URL: ${track.url}\n\n` +
        `Дальше?`,
      reply_markup: kbAdmin(),
    });
    return;
  }

  // fallback
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: "Я тебя понял. Жми кнопки меню 👇",
    reply_markup: kbAdmin(),
  });
}

function stripExt(name) {
  return name.replace(/\.[a-z0-9]+$/i, "");
}

function safeKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\-_ ]/gu, "")
    .replace(/\s+/g, "-")
    .slice(0, 60) || "track";
}

async function uploadTelegramFileToR2(env, fileId, title) {
  // 1) get file path
  const fileInfo = await tg(env, "getFile", { file_id: fileId });
  const path = fileInfo.file_path;
  const tgFileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${path}`;

  // 2) download bytes
  const res = await fetch(tgFileUrl);
  if (!res.ok) throw new Error("Failed to download file from Telegram");

  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const ext = guessExt(contentType, path);
  const key = `tracks/${Date.now()}-${safeKey(title)}${ext}`;

  // 3) put to R2
  const bytes = await res.arrayBuffer();
  await env.R2.put(key, bytes, {
    httpMetadata: { contentType },
  });

  const base = String(env.R2_PUBLIC_BASE || "").replace(/\/+$/, "");
  const publicUrl = base ? `${base}/${key}` : key;

  return { key, publicUrl };
}

function guessExt(contentType, path) {
  const p = (path || "").toLowerCase();
  if (p.endsWith(".mp3") || contentType.includes("mpeg")) return ".mp3";
  if (p.endsWith(".wav") || contentType.includes("wav")) return ".wav";
  if (p.endsWith(".m4a") || contentType.includes("mp4")) return ".m4a";
  if (p.endsWith(".ogg") || contentType.includes("ogg")) return ".ogg";
  return "";
}

async function addToIndex(env, track) {
  const raw = await env.KV.get(TRACKS_KEY);
  const arr = raw ? JSON.parse(raw) : [];
  arr.push(track);
  await env.KV.put(TRACKS_KEY, JSON.stringify(arr));
}

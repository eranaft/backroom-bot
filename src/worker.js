import { Bot, InlineKeyboard, webhookCallback } from "grammy";

/**
 * Secrets (Cloudflare → Worker → Settings → Variables → Secrets):
 * BOT_TOKEN
 * ADMIN_ID   (твой telegram id числом)
 * WEBAPP_URL (ссылка на BACKROOM сайт)
 * R2_PUBLIC_BASE (твоя public base, например https://pub-....r2.dev)
 *
 * Bindings:
 * KV  (KV namespace)
 * R2  (R2 bucket binding)
 */

function isAdmin(ctx, env) {
  const adminId = Number(env.ADMIN_ID || 0);
  const fromId = Number(ctx.from?.id || 0);
  return adminId && fromId === adminId;
}

function kbUser(env) {
  return new InlineKeyboard().url("Открыть BACKROOM", env.WEBAPP_URL);
}

function kbAdminMain() {
  return new InlineKeyboard()
    .text("⬆️ Загрузить (черновик)", "up:draft")
    .text("🚀 Загрузить (паблик)", "up:pub")
    .row()
    .text("📚 Список треков", "list")
    .text("⚙️ Команды", "help");
}

function safeName(s) {
  return String(s || "")
    .trim()
    .replace(/[^\p{L}\p{N}\s._-]+/gu, "")
    .replace(/\s+/g, " ")
    .slice(0, 80);
}

async function kvGetJson(env, key, fallback) {
  const raw = await env.KV.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}
async function kvPutJson(env, key, value) {
  await env.KV.put(key, JSON.stringify(value));
}

async function addTrack(env, track) {
  const list = await kvGetJson(env, "tracks", []);
  list.unshift(track);
  await kvPutJson(env, "tracks", list);
}

async function listTracksText(env) {
  const list = await kvGetJson(env, "tracks", []);
  if (!list.length) return "Пока пусто.";
  return list.slice(0, 30).map((t, i) => {
    const tag = t.visibility === "public" ? "🌍" : "📝";
    return `${i+1}) ${tag} ${t.title} — ${t.r2Key}`;
  }).join("\n");
}

/** Telegram file download → R2 upload */
async function uploadTelegramAudioToR2(ctx, env, visibility) {
  // ждём аудио/документ
  const msg = ctx.message;
  const file =
    msg?.audio ||
    msg?.document ||
    msg?.voice ||
    null;

  if (!file) {
    await ctx.reply("Пришли аудио (mp3) файлом или как audio.");
    return;
  }

  const fileId = file.file_id;
  const tg = `https://api.telegram.org/bot${env.BOT_TOKEN}`;

  // 1) getFile
  const gf = await fetch(`${tg}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const gfJson = await gf.json();
  if (!gfJson.ok) throw new Error("getFile failed");
  const filePath = gfJson.result.file_path;

  // 2) download file (stream)
  const dlUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`;
  const dl = await fetch(dlUrl);
  if (!dl.ok) throw new Error("download failed");

  // 3) determine key
  const ext = (file.file_name && file.file_name.includes(".")) ? file.file_name.split(".").pop() : "mp3";
  const title = safeName(msg?.caption || file.file_name || "track");
  const ts = Date.now();
  const r2Key = `${visibility}/${ts}-${title}.${ext}`.replace(/\s/g, "_");

  // 4) upload to R2
  const contentType = dl.headers.get("content-type") || "audio/mpeg";
  await env.R2.put(r2Key, dl.body, { httpMetadata: { contentType } });

  const publicUrl = env.R2_PUBLIC_BASE
    ? `${env.R2_PUBLIC_BASE.replace(/\/+$/, "")}/${r2Key}`
    : `(нет R2_PUBLIC_BASE)`;

  await addTrack(env, {
    id: String(ts),
    title,
    visibility: visibility === "public" ? "public" : "draft",
    r2Key,
    url: publicUrl,
    createdAt: new Date(ts).toISOString(),
  });

  await ctx.reply(
    `✅ Загружено!\n` +
    `• ${visibility === "public" ? "Паблик" : "Черновик"}\n` +
    `• key: ${r2Key}\n` +
    `• url: ${publicUrl}`
  );
}

const bot = new Bot(""); // token подставим в fetch()

bot.command("start", async (ctx) => {
  const env = ctx.env;
  if (isAdmin(ctx, env)) {
    await ctx.reply("Админ-панель BACKROOM (только для тебя).", { reply_markup: kbAdminMain() });
  } else {
    await ctx.reply("BACKROOM.", { reply_markup: kbUser(env) });
  }
});

bot.callbackQuery(["help"], async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    "Команды (админ):\n" +
    "/start — меню\n" +
    "⬆️ Загрузить (черновик/паблик) — пришли файл после нажатия\n" +
    "📚 Список треков — покажет последние\n"
  );
});

bot.callbackQuery(["list"], async (ctx) => {
  await ctx.answerCallbackQuery();
  const text = await listTracksText(ctx.env);
  await ctx.reply("Треки:\n" + text);
});

bot.callbackQuery(/^up:(draft|pub)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isAdmin(ctx, ctx.env)) return;
  const mode = ctx.match[1];
  const visibility = mode === "pub" ? "public" : "draft";
  await ctx.reply(
    `Ок. Пришли сейчас файл (mp3) одним сообщением.\nРежим: ${visibility === "public" ? "ПАБЛИК" : "ЧЕРНОВИК"}`
  );
  await ctx.env.KV.put("await_upload", JSON.stringify({ chatId: ctx.chat.id, visibility }), { expirationTtl: 300 });
});

// ловим сообщения с файлами только от админа и только если "ожидаем загрузку"
bot.on("message", async (ctx) => {
  const env = ctx.env;
  if (!isAdmin(ctx, env)) return;

  const raw = await env.KV.get("await_upload");
  if (!raw) return;
  let st;
  try { st = JSON.parse(raw); } catch { st = null; }
  if (!st || st.chatId !== ctx.chat.id) return;

  await env.KV.delete("await_upload");
  await uploadTelegramAudioToR2(ctx, env, st.visibility);
});

export default {
  async fetch(request, env, ctx) {
    bot.token = env.BOT_TOKEN;
    return webhookCallback(bot, "cloudflare-mod")(request, env, ctx);
  },
};

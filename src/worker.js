import { Bot, InlineKeyboard, webhookCallback } from "grammy";

/**
 * Bindings:
 * - env.R2  (R2 bucket binding name)
 * - env.KV  (KV namespace binding name)
 * Secrets (Workers -> Settings -> Variables):
 * - BOT_TOKEN
 * - ADMIN_ID
 * - WEBAPP_URL
 * - R2_PUBLIC_BASE
 */

function isAdmin(env, ctx) {
  const adminId = Number(env.ADMIN_ID || 0);
  const fromId = ctx?.from?.id ? Number(ctx.from.id) : 0;
  return adminId && fromId === adminId;
}

function kbUser(env) {
  return new InlineKeyboard().url("Открыть BACKROOM", env.WEBAPP_URL);
}

function kbAdminMain(env) {
  return new InlineKeyboard()
    .text("⬆️ Загрузить (черновик)", "up:draft")
    .text("🚀 Загрузить (паблик)", "up:pub")
    .row()
    .text("📄 Список треков", "list")
    .text("🧠 Помощь", "help");
}

function safeName(s) {
  return String(s || "")
    .trim()
    .replace(/[^\p{L}\p{N}\-._()\s]/gu, "")
    .replace(/\s+/g, " ")
    .slice(0, 80);
}

// Ленивая инициализация: создаём бота только когда env уже доступен
let _bot = null;
function getBot(env) {
  if (_bot) return _bot;

  const token = (env.BOT_TOKEN || "").trim();
  if (!token) {
    // чтобы не падало “втихаря”
    throw new Error("BOT_TOKEN is missing (set it in Worker secrets)");
  }

  const bot = new Bot(token);

  bot.command("start", async (ctx) => {
    if (isAdmin(env, ctx)) {
      await ctx.reply(
        "Админ-панель: выбери действие 👇",
        { reply_markup: kbAdminMain(env) }
      );
    } else {
      await ctx.reply(
        "Добро пожаловать в BACKROOM.",
        { reply_markup: kbUser(env) }
      );
    }
  });

  bot.callbackQuery("help", async (ctx) => {
    if (!isAdmin(env, ctx)) return ctx.answerCallbackQuery({ text: "Нет доступа" });

    await ctx.answerCallbackQuery();
    await ctx.reply(
      [
        "Команды (только для тебя):",
        "/start — меню",
        "⬆️ Загрузить (черновик) — загрузка и сохранение как draft",
        "🚀 Загрузить (паблик) — загрузка и публикация",
        "📄 Список треков — покажу, что лежит в базе",
        "",
        "Пользователям — только кнопка «Открыть BACKROOM».",
      ].join("\n")
    );
  });

  bot.callbackQuery("list", async (ctx) => {
    if (!isAdmin(env, ctx)) return ctx.answerCallbackQuery({ text: "Нет доступа" });

    await ctx.answerCallbackQuery();

    // Пока заглушка — позже сделаем реальный список из KV
    await ctx.reply("Список треков: (позже подключим KV/R2 индексацию)");
  });

  // TODO: позже добавим “пришли файл -> я загружу в R2”
  bot.callbackQuery(/up:(draft|pub)/, async (ctx) => {
    if (!isAdmin(env, ctx)) return ctx.answerCallbackQuery({ text: "Нет доступа" });

    const mode = ctx.match?.[1];
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `Ок. Режим: ${mode}. Пришли мне аудио-файл (mp3) и подписью: название/артист/описание.\n` +
      `Пример: "Track 03 — KRAMSKOY | demo | 128bpm"`
    );
  });

  _bot = bot;
  return bot;
}

// webhook handler
export default {
  async fetch(request, env, ctx) {
    try {
      // принимаем апдейты и на / и на /webhook
      const url = new URL(request.url);
      if (request.method === "GET") return new Response("OK");
      if (request.method === "POST" && (url.pathname === "/" || url.pathname === "/webhook")) {
        const bot = getBot(env);
        const handle = webhookCallback(bot, "cloudflare-mod");
        return handle(request);
      }
      return new Response("Not found", { status: 404 });
    } catch (e) {
      return new Response(String(e?.message || e), { status: 500 });
    }
  }
};

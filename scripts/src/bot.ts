import { Telegraf } from "telegraf";
import OpenAI from "openai";

const TELEGRAM_BOT_TOKEN = process.env["TELEGRAM_BOT_TOKEN"];
const OPENROUTER_API_KEY = process.env["OPENROUTER_API_KEY"];

if (!TELEGRAM_BOT_TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN environment variable is required");
}

if (!OPENROUTER_API_KEY) {
  throw new Error("OPENROUTER_API_KEY environment variable is required");
}

const openrouter = new OpenAI({
  apiKey: OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

const PRIMARY_MODEL = "openai/gpt-oss-120b:free";
const FALLBACK_MODELS = [
  "google/gemma-4-31b-it:free",
  "qwen/qwen3-next-80b-a3b-instruct:free",
  "openai/gpt-oss-20b:free",
];

function isRateLimitError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("429") ||
      error.message.toLowerCase().includes("rate limit") ||
      error.message.toLowerCase().includes("quota"))
  );
}

async function generateWithRetry(prompt: string): Promise<string> {
  const models = [PRIMARY_MODEL, ...FALLBACK_MODELS];

  for (const model of models) {
    try {
      console.log(`Trying model: ${model}`);
      const response = await openrouter.chat.completions.create({
        model,
        max_tokens: 8192,
        messages: [{ role: "user", content: prompt }],
      });

      const text = response.choices[0]?.message?.content;
      if (!text) throw new Error("Empty response from model");
      console.log(`Success with model: ${model}`);
      return text;
    } catch (error) {
      console.error(`Error with model ${model}:`, error instanceof Error ? error.message : error);
      if (isRateLimitError(error)) {
        console.log(`Rate limited on ${model}, trying next model...`);
        continue;
      }
      throw error;
    }
  }

  throw new Error("Все модели недоступны. Попробуйте позже.");
}

async function googleSearch(query: string): Promise<string[]> {
  try {
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=5`;
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });

    const html = await response.text();
    const linkRegex = /href="\/url\?q=(https?:\/\/[^&"]+)/g;
    const links: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = linkRegex.exec(html)) !== null && links.length < 5) {
      const decodedUrl = decodeURIComponent(match[1]);
      if (
        !decodedUrl.includes("google.com") &&
        !decodedUrl.includes("googleapis.com")
      ) {
        links.push(decodedUrl);
      }
    }

    return links;
  } catch (error) {
    console.error("Search error:", error);
    return [];
  }
}

async function fetchPageSnippet(url: string): Promise<string> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });
    clearTimeout(timeout);

    const html = await response.text();
    const textContent = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    return textContent.slice(0, 1000);
  } catch {
    return "";
  }
}

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

bot.command("start", (ctx) => {
  ctx.reply(
    "Привет! Я бот с искусственным интеллектом (OpenRouter). Задайте мне любой вопрос, и я найду актуальную информацию в интернете и дам подробный ответ.",
  );
});

bot.on("text", async (ctx) => {
  const userText = ctx.message.text;
  console.log(`Received message: ${userText}`);

  try {
    await ctx.sendChatAction("typing");

    const links = await googleSearch(userText);
    console.log(`Found ${links.length} search results`);

    let searchContext = "";
    if (links.length > 0) {
      const snippets = await Promise.all(
        links.slice(0, 3).map(async (url) => {
          const snippet = await fetchPageSnippet(url);
          return snippet ? `Источник: ${url}\nСодержимое: ${snippet}` : "";
        }),
      );
      searchContext = snippets.filter(Boolean).join("\n\n");
    }

    const prompt = `Ответь на вопрос пользователя, используя актуальную информацию из интернета.

Вопрос: ${userText}

Найденные ссылки:
${links.length > 0 ? links.join("\n") : "(поиск не дал результатов)"}

Контекст из найденных страниц:
${searchContext || "(контекст недоступен)"}

Дай подробный и полезный ответ на русском языке. Если есть релевантные ссылки, включи их в ответ.`;

    const responseText = await generateWithRetry(prompt);

    if (responseText.length > 4096) {
      const chunks = responseText.match(/[\s\S]{1,4096}/g) || [];
      for (const chunk of chunks) {
        await ctx.reply(chunk);
      }
    } else {
      await ctx.reply(responseText);
    }
  } catch (error) {
    console.error("Error processing message:", error);
    const msg = error instanceof Error ? error.message : "Неизвестная ошибка";
    await ctx.reply(`⚠️ Ошибка: ${msg}`);
  }
});

bot.catch((err: unknown) => {
  console.error("Bot error:", err);
});

console.log("Бот с OpenRouter запущен...");
bot.launch();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

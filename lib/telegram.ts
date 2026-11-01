export function telegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

export async function sendTelegramMessages(messages: string[], options?: { html?: boolean }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw new Error("Telegram belum diatur.");
  }

  for (const text of messages) {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: options?.html === false ? undefined : "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 180);
      throw new Error(`Telegram menolak pesan (${response.status}). ${detail}`);
    }
  }
}

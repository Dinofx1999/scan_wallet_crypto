// src/utils/Telegram.js
const axios = require("axios");

/**
 * Gửi tin nhắn Telegram
 * @param {string} message - Nội dung tin nhắn
 * @param {string|number} chatId - Chat ID
 * @param {string} botToken - Bot Token
 */
async function sendTelegram(message, chatId, botToken) {
  if (!message || !chatId || !botToken) {
    throw new Error("Missing message, chatId or botToken");
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  try {
    const res = await axios.post(
      url,
      {
        chat_id: chatId,
        text: message,
        parse_mode: "HTML", // cho phép format <b>...</b>
        disable_web_page_preview: true,
      },
      {
        timeout: 10000,
      }
    );

    return res.data;
  } catch (error) {
    console.error("❌ Telegram error:", error.response?.data || error.message);
    throw error;
  }
}

module.exports = sendTelegram;
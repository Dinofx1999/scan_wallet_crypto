// src/controllers/ScronWallet.js
// Cron scan "TIỀN NHẬN" (incoming) USDT TRC20 cho NHIỀU ví (3-5 ví hoặc hơn)
// ✅ Chỉ lấy incoming: to_address === wallet
// ✅ Chỉ nhận USDT contract TRC20
// ✅ Chỉ nhận confirmed + SUCCESS
// ✅ Chống xử lý trùng txid (state file)
// ✅ Log thời gian GMT+7 (Asia/Ho_Chi_Minh)
// ✅ Retry/backoff khi gặp 429 rate-limit
// ✅ File-lock để tránh chạy trùng khi dev reload/pm2 (1 máy)
// Cài deps: npm i axios node-cron
//
// .env ví dụ:
//   WALLETS=TJMBQuS48eNjAtJkvmjGQF8idBbvfNiTjt,TXXXXXXXXXXXXXXXXXXXXXXXXXXXX
//   CRON_WALLET=*/3 * * * *
//   TRONSCAN_LIMIT=20
//   TRONSCAN_MAX_PAGES=3
//   CRON_STATE_FILE=./wallet_cron_state.json
//   CRON_LOCK_FILE=./wallet_cron.lock
const mongoose = require("mongoose");
const WalletDeposit = require("../models/WalletDeposit");
const sendTelegram = require("../utils/Telegram");
const axios = require("axios");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");



// ====== CONFIG ======
const API_URL = "https://apilist.tronscan.org/api/token_trc20/transfers";
const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const DEFAULT_DECIMALS = 6;

// WALLETS format: "address-name,address-name,..."
const walletPairsRaw = (process.env.WALLETS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// map address -> displayName
const walletNameMap = new Map();

// list address to scan
const WALLETS = walletPairsRaw
  .map((pair) => {
    // split at FIRST "-" only (name can contain "-")
    const idx = pair.indexOf("-");
    if (idx === -1) {
      const addr = pair.trim();
      walletNameMap.set(addr, addr);
      return addr;
    }
    const addr = pair.slice(0, idx).trim();
    const name = pair.slice(idx + 1).trim() || addr;

    walletNameMap.set(addr, name);
    return addr;
  })
  .filter(Boolean);

function walletLabel(address) {
  return walletNameMap.get(address) || address;
}

const CRON_EXPR = process.env.CRON_WALLET || "*/3 * * * *";
const LIMIT = Number(process.env.TRONSCAN_LIMIT || 20);
const MAX_PAGES = Number(process.env.TRONSCAN_MAX_PAGES || 3);

const STATE_FILE = path.resolve(process.env.CRON_STATE_FILE || "./wallet_cron_state.json");
const LOCK_FILE = path.resolve(process.env.CRON_LOCK_FILE || "./wallet_cron.lock");

// ====== TIMEZONE (GMT+7) ======
const TZ = "Asia/Ho_Chi_Minh";
function formatVN(tsMs) {
  // "2026-02-20 07:11:18 GMT+7"
  const s = new Date(tsMs)
    .toLocaleString("sv-SE", { timeZone: TZ, hour12: false })
    .replace("T", " ");
  return `${s} VN`;
}

// ====== HELPERS ======
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function axiosGetWithRetry(url, config, { retries = 6, baseDelayMs = 900 } = {}) {
  let attempt = 0;

  while (true) {
    try {
      return await axios.get(url, config);
    } catch (err) {
      const status = err?.response?.status;
      const retryAfter = Number(err?.response?.headers?.["retry-after"] || 0);

      const retriable =
        status === 429 ||
        (status >= 500 && status <= 599) ||
        !status; // network/timeouts

      if (!retriable || attempt >= retries) throw err;

      const delay =
        (retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * Math.pow(2, attempt)) +
        Math.floor(Math.random() * 250);

      console.warn(
        `⚠️ Tronscan limited (status=${status}). Retry in ${delay}ms (attempt ${attempt + 1}/${retries})`
      );
      await sleep(delay);
      attempt += 1;
    }
  }
}

function safeReadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function safeWriteJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.error("⚠️ Failed to write state file:", e.message);
  }
}

function acquireLock() {
  try {
    const fd = fs.openSync(LOCK_FILE, "wx"); // fail if exists
    fs.writeFileSync(fd, String(Date.now()));
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function releaseLock() {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {}
}

function quantToTokenAmount(quantStr, decimals) {
  const dec = Number.isFinite(decimals) ? decimals : DEFAULT_DECIMALS;
  const q = BigInt(String(quantStr || "0"));
  const d = BigInt(10) ** BigInt(dec);

  const intPart = q / d;
  const fracPart = q % d;

  const frac = fracPart.toString().padStart(dec, "0").replace(/0+$/, "");
  return frac ? Number(`${intPart.toString()}.${frac}`) : Number(intPart.toString());
}

// Hook: thay bằng logic cộng tiền / lưu DB / publish Redis...
async function onIncomingDeposit(wallet, tx) {
  const doc = {
    wallet,
    userId: null,
    chain: "TRON",
    tokenType: "trc20",
    tokenSymbol: tx.symbol,
    tokenContract: USDT_CONTRACT,
    tokenDecimals: tx.decimals ?? 6,

    txid: tx.txid,
    fromAddress: tx.from,
    toAddress: tx.to,

    amountRaw: String(tx.amountRaw ?? tx.quant ?? ""),
    amount: mongoose.Types.Decimal128.fromString(String(tx.amount)),

    blockNumber: tx.block ?? null,
    blockTs: tx.block_ts,
    confirmed: true,
    contractRet: tx.contractRet ?? "SUCCESS",
    finalResult: tx.finalResult ?? "SUCCESS",
    revert: tx.revert ?? false,
    riskTransaction: tx.riskTransaction ?? false,

    raw: tx.raw ?? null,
    status: "DETECTED",
  };

  const result = await WalletDeposit.updateOne(
    { wallet, txid: tx.txid },
    { $setOnInsert: doc },
    { upsert: true }
  );

  const inserted = (result?.upsertedCount || 0) > 0;
  if (!inserted) return; // ✅ đã tồn tại thì thôi

  const name = walletLabel(wallet);
function shortAddress(address, start = 6, end = 6) {
  if (!address || address.length <= start + end) return address;
  return `${address.slice(0, start)}......${address.slice(-end)}`;
}
  await sendTelegram(
    `<b>🎉 Bạn vừa nhận được tiền!</b>
━━━━━━━━━━━━━━━━━━
👤 <b>Tài Khoản:</b> ${name}
💰 <b>Số Tiền:</b> <b><u>${tx.amount} ${tx.symbol}</u></b>
━━━━━━━━━━━━━━━━━━
🏦 <b>Người gửi:</b> <code>${shortAddress(tx.from)}</code>
🕒 <b>Thời Gian:</b> ${formatVN(tx.block_ts)}
<i>Chúc 2 Anh Em giao dịch thuận lợi 🚀</i>`,
    process.env.TELEGRAM_CHAT_ID,
    process.env.TELEGRAM_BOT_TOKEN
  );

  console.log(
    `✅ NEW DEPOSIT wallet=${name} +${tx.amount} ${tx.symbol} | from=${tx.from} | txid=${tx.txid} | time=${formatVN(
      tx.block_ts
    )}`
  );
}

function loadState() {
  const st = safeReadJson(STATE_FILE, { wallets: {} });
  if (!st.wallets) st.wallets = {};
  for (const w of WALLETS) {
    if (!st.wallets[w]) st.wallets[w] = { lastTs: 0, processed: {} };
  }
  return st;
}

function pruneProcessed(mapObj, keepLast = 3000) {
  const entries = Object.entries(mapObj || {});
  if (entries.length <= keepLast) return mapObj || {};
  entries.sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0));
  return Object.fromEntries(entries.slice(0, 2000));
}

async function fetchIncomingSince(wallet, lastTs) {
  let start = 0;
  let page = 0;
  const incoming = [];

  while (page < MAX_PAGES) {
    const res = await axiosGetWithRetry(
      API_URL,
      {
        params: {
          relatedAddress: wallet,
          contract_address: USDT_CONTRACT,
          limit: LIMIT,
          start,
          sort: "-timestamp",
        },
        timeout: 15000,
        headers: { Accept: "application/json", "User-Agent": "wallet-cron/1.0" },
      },
      { retries: 6, baseDelayMs: 900 }
    );

    const list = res.data?.token_transfers || [];
    if (!Array.isArray(list) || list.length === 0) break;

    for (const t of list) {
      const block_ts = Number(t.block_ts || 0);
      const to = String(t.to_address || "").trim();
      const txid = t.transaction_id;

      // chỉ incoming
      if (to !== wallet) continue;

      // chỉ lấy tx mới hơn lastTs
      if (block_ts <= lastTs) {
        // sorted desc => gặp cũ là dừng luôn
        return incoming;
      }

      incoming.push(t);
    }

    start += LIMIT;
    page += 1;
  }

  return incoming;
}

async function processWallet(wallet, wState) {
  const lastTs = Number(wState.lastTs || 0);

  const incoming = await fetchIncomingSince(wallet, lastTs);
  if (!incoming.length) return wState;

  // xử lý cũ -> mới
  incoming.sort((a, b) => Number(a.block_ts || 0) - Number(b.block_ts || 0));

  for (const t of incoming) {
    const txid = t.transaction_id;
    const block_ts = Number(t.block_ts || 0);

    // chỉ confirmed + success
    if (t.confirmed !== true) continue;
    if (t.contractRet !== "SUCCESS" && t.finalResult !== "SUCCESS") continue;
    if (t.revert === true) continue;

    // anti-duplicate
    wState.processed = wState.processed || {};
    if (wState.processed[txid]) continue;
    wState.processed[txid] = block_ts;

    const decimals = Number(t?.tokenInfo?.tokenDecimal ?? DEFAULT_DECIMALS);
    const symbol = t?.tokenInfo?.tokenAbbr || "USDT";
    const amount = quantToTokenAmount(t.quant, decimals);

    await onIncomingDeposit(wallet, {
      txid,
      from: t.from_address,
      to: t.to_address,
      amount,
      symbol,
      decimals,
      amountRaw: t.quant,          // ✅ để lưu amountRaw
      block_ts,
      block: t.block,
      contractRet: t.contractRet,  // ✅ lưu trạng thái thật
      finalResult: t.finalResult,
      revert: t.revert,
      riskTransaction: t.riskTransaction,
      raw: t,                      // ✅ lưu raw để audit
    });

    if (block_ts > wState.lastTs) wState.lastTs = block_ts;
  }

  wState.processed = pruneProcessed(wState.processed, 3000);
  return wState;
}

// ====== MAIN ======
function CronJob() {
  if (!WALLETS.length) {
    console.error("❌ Missing WALLETS in .env. Example: WALLETS=TJMB...,TXXXX...");
    return;
  }

  console.log(
    `🕒 Cron Wallet started | wallets=${WALLETS.map(w => walletLabel(w)).join(", ")} | cron="${CRON_EXPR}" | state=${STATE_FILE}`
  );

  const run = async () => {
    // file-lock: tránh chạy trùng
    if (!acquireLock()) return;

    try {
      const state = loadState();

      // scan lần lượt để giảm rate limit
      for (const wallet of WALLETS) {
        const wState = state.wallets[wallet] || { lastTs: 0, processed: {} };

        try {
          state.wallets[wallet] = await processWallet(wallet, wState);
          // nghỉ nhẹ giữa ví để tránh 429
          await sleep(350);
        } catch (e) {
          console.error(`❌ wallet=${wallet} error:`, e.response?.status, e.message);
        }
      }

      safeWriteJson(STATE_FILE, state);
    } finally {
      releaseLock();
    }
  };

  // chạy ngay khi start server
  run().catch((e) => console.error("runOnce error:", e.response?.status, e.message));

  // schedule
  cron.schedule(CRON_EXPR, () => {
    run().catch((e) => console.error("cron run error:", e.response?.status, e.message));
  });
}

module.exports = CronJob;
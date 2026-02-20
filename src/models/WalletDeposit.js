// src/models/WalletDeposit.js
const mongoose = require("mongoose");

const WalletDepositSchema = new mongoose.Schema(
  {
    // Ví nhận (địa chỉ TRON)
    wallet: { type: String, required: true, index: true, trim: true },

    // Nếu anh map wallet -> userId thì lưu luôn (optional)
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true, default: null },

    // Chain info
    chain: { type: String, default: "TRON", index: true }, // future-proof
    tokenType: { type: String, default: "trc20", index: true },

    // Token info
    tokenSymbol: { type: String, required: true, index: true, trim: true }, // "USDT"
    tokenContract: { type: String, required: true, index: true, trim: true }, // TR7NHq...
    tokenDecimals: { type: Number, default: 6 },

    // Transaction
    txid: { type: String, required: true, trim: true },
    fromAddress: { type: String, required: true, trim: true, index: true },
    toAddress: { type: String, required: true, trim: true },

    // Amount
    amountRaw: { type: String, required: true }, // quant "10229460000" (string)
    amount: { type: mongoose.Schema.Types.Decimal128, required: true }, // 10229.46

    // Block / status
    blockNumber: { type: Number, index: true, default: null },
    blockTs: { type: Number, required: true, index: true }, // ms
    confirmed: { type: Boolean, default: false, index: true },
    contractRet: { type: String, default: null },
    finalResult: { type: String, default: null },
    revert: { type: Boolean, default: false },
    riskTransaction: { type: Boolean, default: false },

    // Business processing
    status: {
      type: String,
      enum: ["DETECTED", "CREDITED", "IGNORED", "FAILED"],
      default: "DETECTED",
      index: true,
    },
    creditedAt: { type: Date, default: null },
    note: { type: String, default: null },

    // Audit/debug payload (optional)
    raw: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

// Unique chống trùng: cùng 1 txid nạp vào cùng 1 wallet chỉ lưu 1 lần
WalletDepositSchema.index({ wallet: 1, txid: 1 }, { unique: true });

// Query nhanh lịch sử deposit của user theo thời gian
WalletDepositSchema.index({ userId: 1, blockTs: -1 });

// Query nhanh theo wallet + time
WalletDepositSchema.index({ wallet: 1, blockTs: -1 });

module.exports = mongoose.model("WalletDeposit", WalletDepositSchema);
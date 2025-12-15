import mongoose from "mongoose";

const bonusSchema = new mongoose.Schema({
    chat_id: String,
    amount: {
      type: Number,
      default: 0
    },
    claimed_at: Date,
}, { timestamps: true });

export const Bonus = mongoose.model('bonuses', bonusSchema);
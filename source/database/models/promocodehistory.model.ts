import mongoose from "mongoose";

const promoCodeHistorySchema = new mongoose.Schema({
    chat_id: String,
    promo_code: String,
    claimed_at: Date,
}, { timestamps: true });

export const PromoCodeHistory = mongoose.model('promocodehistories', promoCodeHistorySchema);
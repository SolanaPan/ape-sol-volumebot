import mongoose from "mongoose";

const refCodeSchema = new mongoose.Schema({
  code: String,
  chat_id: Number,
  used: {
    type: mongoose.Schema.Types.Boolean,
    default: false,
  },
  used_at: Date,
  used_by: String,
  expires_at: Date,
}, { timestamps: true });

export const RefCode = mongoose.model('refcode', refCodeSchema);
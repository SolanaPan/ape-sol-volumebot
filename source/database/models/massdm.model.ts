import mongoose from "mongoose";

const massDMSchema = new mongoose.Schema({
    message: String,
    file_id: String,
    message_type: Number,
  }, { timestamps: true });

export const MassDM = mongoose.model('massdms', massDMSchema);

import mongoose from "mongoose";

const notificationSchema = new mongoose.Schema({
    chat_id: {
      type: String,
      required: true,
      index: true
    },
    message: String,
    file_link: String,
    message_type: {
      type: Number,
      default: 1
    },
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed'],
      default: 'pending',
    },
    processedAt: {
      type: Date
    },
    errorMessage: String,
    retryCount: {
      type: Number,
      default: 0
    }
}, { timestamps: true });

export const DMNotification = mongoose.model('notifications', notificationSchema);
  
import axios from "axios";
import { DMNotification } from "../database/models/notification.model";

export class NotificationProcessor {
  bot: any;
  database: any;
  batchSize: any;
  intervalSeconds: any;
  delayBetweenMessages: any;
  isProcessing: any;
  timerId: any;
  fileCache: Map<any, any>;

  constructor(config:any) {
    this.bot = config.bot;
    this.database = config.database;
    this.batchSize = config.batchSize || 30;
    this.intervalSeconds = config.intervalSeconds || 2;
    this.delayBetweenMessages = config.delayBetweenMessages || 50;
    this.isProcessing = false;
    this.fileCache = new Map();
  }

  /**
   * Add new notifications to the queue
   */
  async queueNotifications(notifications:any) {
    await this.database.insertNotifications(notifications);
    console.log(`Queued ${notifications.length} new notifications:`, notifications);
  }

  /**
   * Start the notification processing loop
   */
  async startProcessing() {
    console.log(`Starting notification processor (Batch size: ${this.batchSize}, Interval: ${this.intervalSeconds} seconds)`);
    
    // Initial processing
    await this.processNextBatch();
    
    // Set up interval for subsequent processing
    this.timerId = setInterval(async () => {
      await this.processNextBatch();
    }, this.intervalSeconds * 1000);
  }

  /**
   * Stop the notification processing loop
   */
  async stopProcessing() {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.fileCache.clear();
    }
  }

  /**
   * Process next batch of notifications
   */
  async processNextBatch() {
    if (this.isProcessing) {
      console.log('Previous batch still processing, skipping...');
      return;
    }

    this.isProcessing = true;

    try {
      // Find and mark next batch of notifications as processing
      // First find the pending notifications
      const notifications = await DMNotification.find({  
        $or: [
          { status: 'pending' },
          {
            $and: [
              { status: 'failed' },
              { retryCount: { $lt: 3 } }
            ]
          }
        ]
      })
      .sort({ createdAt: 1 })
      .limit(this.batchSize);

      if (!notifications || notifications.length === 0) {
        console.log('No pending notifications found');
        this.stopProcessing();
        return;
      }

      // Get the IDs of found notifications
      const notificationIds = notifications.map(n => n._id);

      // Mark them as processing
      await DMNotification.updateMany(
        { _id: { $in: notificationIds } },
        { 
          $set: { 
            status: 'processing',
            processedAt: new Date()
          }
        }
      );

      console.log(`Processing ${notifications.length} notifications`);

      // Process each notification
      for (const [index, notification] of notifications.entries()) {
        try {
          // Add delay between messages
          await this.delay(index * this.delayBetweenMessages);

          console.log(`Notification type ${notification.message_type}:`, notification.message);
          if (notification.message_type == 1) {
            // Send message
            try {
              await this.bot.api.sendMessage(notification?.chat_id, notification?.message, {
                parse_mode: "HTML",
                disable_web_page_preview: false,
              });
            } catch (error:any) {
              console.error('Failed to send message:', error?.message);
            }
          } else if (notification.message_type == 2) {
            // Send photo
            let file = this.fileCache.get(notification?.file_link);
            if (file === undefined) {
              file = await this.bot.api.getFile(notification?.file_link);
              if (file) {
                this.fileCache.set(notification?.file_link, file);
              }
            }

            if (file) {
              await this.bot.api.sendPhoto(notification?.chat_id, file.file_id, {
                caption: notification?.message,
                parse_mode: "HTML",
              });
            } else {
              console.log('Failed to download file');
            }
          } else if (notification.message_type == 3) {
            // Send Video
            let file = this.fileCache.get(notification?.file_link);
            if (file === undefined) {
              file = await this.bot.api.getFile(notification?.file_link);
              if (file) {
                this.fileCache.set(notification?.file_link, file);
              }
            }

            if (file) {
              await this.bot.api.sendAnimation(notification?.chat_id, file.file_id, {
                caption: notification?.message,
                parse_mode: "HTML",
              });
            } else {
              console.log('Failed to download file');
            }
          } else if (notification.message_type == 4) {
            // Send Video
            let file = this.fileCache.get(notification?.file_link);
            if (file === undefined) {
              file = await this.bot.api.getFile(notification?.file_link);
              if (file) {
                this.fileCache.set(notification?.file_link, file);
              }
            }

            if (file) {
              await this.bot.api.sendVideo(notification?.chat_id, file.file_id, {
                caption: notification?.message,
                parse_mode: "HTML",
              });
            } else {
              console.log('Failed to download file');
            }
          } else if (notification.message_type == 5) {
            // Send Document
            let file = this.fileCache.get(notification?.file_link);
            if (file === undefined) {
              file = await this.bot.api.getFile(notification?.file_link);
              if (file) {
                this.fileCache.set(notification?.file_link, file);
              }
            }

            if (file) {
              await this.bot.api.sendDocument(notification?.chat_id, file.file_id, {
                caption: notification?.message,
                parse_mode: "HTML",
              });
            } else {
              console.log('Failed to download file');
            }
          } else if (notification.message_type == 6) {
            // Send Voice
            let file = this.fileCache.get(notification?.file_link);
            if (file === undefined) {
              file = await this.bot.api.getFile(notification?.file_link);
              if (file) {
                this.fileCache.set(notification?.file_link, file);
              }
            }

            if (file) {
              await this.bot.api.sendVoice(notification?.chat_id, file.file_id, {
                caption: notification?.message,
                parse_mode: "HTML",
              });
            } else {
              console.log('Failed to download file');
            }
          } else {
            console.log('Unknown message type');
          }

          // Mark as completed
          await DMNotification.findByIdAndUpdate(notification._id, {
            $set: {
              status: 'completed',
              processedAt: new Date()
            }
          });

        } catch (error:any) {
          console.error(`Failed to send notification ${notification._id}:`, error.message);

          // Mark as failed
          await DMNotification.findByIdAndUpdate(notification._id, {
            $set: {
              status: 'failed',
              processedAt: new Date(),
              errorMessage: error.message
            },
            $inc: { retryCount: 1 }
          });
        }
      }

    } catch (error) {
      console.error('Error processing batch:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Helper method for delays
   */
  delay(ms:number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get processing statistics
   */
  async getStats() {
    const stats = await DMNotification.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ]);

    return stats.reduce((acc, stat) => {
      acc[stat._id] = stat.count;
      return acc;
    }, {});
  }

  /**
   * Clean up old completed notifications
   * @param {number} daysToKeep - Number of days to keep completed notifications
   */
  async cleanupOldNotifications(daysToKeep = 30) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    let result = await this.database.cleanupOldNotifications(cutoffDate);

    console.log(`Cleaned up ${result.deletedCount} old notifications`);
  }
}

// Example usage:
export async function sendMassDM(notifications:any) {
  const processor = new NotificationProcessor({
    batchSize: 20,
    intervalSeconds: 5,
    delayBetweenMessages: 300
  });

  // Queue some notifications
  await processor.queueNotifications(notifications);

  // Start processing
  await processor.startProcessing();

  // Clean up old notifications every day
  setInterval(async () => {
    await processor.cleanupOldNotifications(30);
  }, 24 * 60 * 60 * 1000);

  // Check stats periodically
  setInterval(async () => {
    const stats = await processor.getStats();
    // console.log('Current notification stats:', stats);
  }, 60000);
}
import mongoose from "mongoose";

const zombieSchema = new mongoose.Schema({
    publickey: String,
    privatekey: String,
    type: String,
    userId: Number,
}, { timestamps: true });

export default mongoose.model("Zombie", zombieSchema);
import mongoose from "mongoose";

const zombieSchema = new mongoose.Schema({
    publickey: String,
    privatekey: String,
    type: String,
}, { timestamps: true });

export default mongoose.model("Zombie", zombieSchema);
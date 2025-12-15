import mongoose from "mongoose";

const walletVersionSchema = new mongoose.Schema({
    isValid: Boolean,
	version: Number,
});

export default mongoose.model("WalletVersion", walletVersionSchema);

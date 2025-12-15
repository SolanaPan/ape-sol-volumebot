import mongoose from "mongoose";

const walletSchema = new mongoose.Schema({
	publickey: String,
	privatekey: String,
	type: String,
	walletNum: Number,
	version: Number,
});

export default mongoose.model("Wallet", walletSchema);
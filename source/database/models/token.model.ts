import mongoose from "mongoose";

const contractSchema = new mongoose.Schema({
	address: String,
	name: String,
	symbol: String,
	decimals: Number,
	totalSupply: String,
	is2022: Boolean,
}, { timestamps: true });

export default mongoose.model("Token", contractSchema);

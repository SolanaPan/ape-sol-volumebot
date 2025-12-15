import mongoose from "mongoose";

const adminSchema = new mongoose.Schema({
    isDispersing: {
		type: Boolean,
		default: false
	},
    isGenerating: {
		type: Boolean,
		default: false
	},
	promo_code: String,
	promo_text: String,
	one_k_vol_price: {
		type: Number,
		default: 0.016	// default value for sol_price 250
	},
	tax_rate: {
		type: Number,
		default: 0.01	//
	},
	tax_enabled: {
		type: Boolean,
		default: true
	},
});

export default mongoose.model("Admin", adminSchema);

import mongoose from "mongoose";

const volumeBotSchema = new mongoose.Schema({
	userId: Number,
	enable: { type: Boolean, default: false },
	isPending: { type: Boolean, default: true },
	token: { type: mongoose.Schema.Types.ObjectId, ref: "Token" },
	mainWallet: {
		publicKey: String,
		privateKey: String,
	},
	subWalletNums: { type: Number, default: 4 },
	addressLookupTable: { type: String, default: "" },
	pairAddress: { type: String, default: "" },
	poolType: { type: String, default: "" },
	dexId: { type: String, default: "" },
	boostType: { 
		volumeBoost: { type: Boolean, default: true },
		makerBoost: { type: Boolean, default: false },
		holderBoost: { type: Boolean, default: false },
	},
	organicMode: { type: Boolean, default: false },
	targetVolume: { type: Number, default: 10000 },	// 10k
	targetMaker: { type: Number, default: 1000 }, // 1k
    targetHolder: { type: Number, default: 100 }, // 0.1k
	depositAmount: { type: Number, default: 1 },
	maxBuy: { type: Number, default: 0.01 },
	workedSeconds: { type: Number, default: 0 },
	volumeMade: { type: Number, default: 0 },
	makerMade: { type: Number, default: 0 },
	holderMade: { type: Number, default: 0 },
	status: { type: Number, default: 0 },
	startStopFlag: { type: Number, default: 0 },
	usedWallet: { type: Number, default: 0 },
	txDone: { type: Number, default: 0 },
	feePaid: { type: Number, default: 0 },
	maxTxAmount: { type: Number, default: 1 },
	startSolAmount: { type: Number, default: 0 },
	delayTime: { type: Number, default: 30 }, // 30 seconds
}, { timestamps: true });

export default mongoose.model("VolumeBot", volumeBotSchema);

import mongoose from "mongoose";

const UserSchema = new mongoose.Schema({
    chatid: String,
    username: String,
    depositWallet: String,
    withdrawWallet: String,
    gatherDate: Number,
    referredBy: String,
    referredTimestamp: Number,
    timestamp: Number,
    // dexId: String,
    // poolType: String,
    // pairAddress: String
});

const UserModel = mongoose.model("User", UserSchema);

// Correct export syntax for ES Modules
export default UserModel;

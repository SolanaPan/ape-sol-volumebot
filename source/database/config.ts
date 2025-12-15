import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();
const MONGO_URI = `mongodb://${process.env.DB_USER}:${process.env.DB_PWD}@127.0.0.1:27017/${process.env.DB_NAME}?authSource=admin`;

console.log(`connecting ${MONGO_URI}`);
export function connectDatabase(callback: any): void {
	mongoose.set('strictQuery', false);
	mongoose.connect(MONGO_URI).then(() => {
		console.log("Mongoose Connected");
		if (callback) callback();
	});
}

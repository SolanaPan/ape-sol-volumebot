import { ADMIN_USERS } from "./bot/const";
import { generateWallets, start, main } from "./bot/index";

// eslint-disable-next-line @typescript-eslint/no-floating-promises
generateWallets();
start();
main();

// Gracefully stop the process on SIGINT
process.on("SIGINT", () => {
	console.log("Quitting the Telegram bot...");
	// Additional cleanup or shutdown tasks can be performed here
	process.exit(0); // Exit the process
});

import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { formatNumberWithUnit, getSolanaPriceBinance, SOL_PRICE } from "./common";

interface TokenDetails {
    name: string;
    symbol: string;
    totalSupply: string;
    decimals: number;
}

export const BOT_STATUS = {
    NOT_STARTED: 0,
    ARCHIVED_TARGET_VOLUME: 1,
    RUNNING: 2,
    STOPPED_DUE_TO_MAIN_WALLET_BALANCE: 3,
    STOPPED_DUE_TO_SUB_WALLETS_BALANCE: 4,
    STOPPED_DUE_TO_OTHER_ERROR: 5,
    STOPPED_DUE_TO_SIMULATION_ERROR: 6,
    STOPPED_BY_USER: 7,
};

interface BotStats {
    workedSeconds: number;
    volumeMade: number;
    makerMade: number;
    holderMade: number;
    pairAddress: string;
    poolType: string;
    dexId: string;
    maxBuy: number,
    delayTime: number,
    targetVolume: number;
    targetMaker: number;
    targetHolder: number;
    organicMode: boolean;
    txDone: number;
    subWalletNums: number;
    status: number;
    startStopFlag: number;
}

interface WalletInfo {
    address: string; // publicKey
    balance: number; // Balance in SOL
}

/**
 * Formats a given number of seconds into a readable time string.
 * @param totalSeconds The total number of seconds.
 * @returns A string representing the formatted time like "3m 13s", "13h 25m 34s", etc.
 */
function formatTime(totalSeconds: number): string {
    const days = Math.floor(totalSeconds / (3600 * 24));
    const hours = Math.floor((totalSeconds % (3600 * 24)) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);

    let result = "";

    if (days > 0) {
        result += `${days}d `;
    }
    if (days > 0 || hours > 0) {
        result += `${hours}h `;
    }
    if (days > 0 || hours > 0 || minutes > 0) {
        result += `${minutes}m `;
    }
    if (days > 0 || hours > 0 || minutes > 0 || seconds >= 0) {
        result += `${seconds}s`;
    }

    return result.trim(); // Remove any trailing space
}

/**
 * Formats a USD amount into a more readable string with abbreviations.
 * @param amount The amount of USD as a number.
 * @returns A formatted string with the amount abbreviated in a readable format.
 */
function formatUSD(amount: number): string {
    if (amount >= 1_000_000_000) {
        return `${(amount / 1_000_000_000).toFixed(2)}B USD`;
    } else if (amount >= 1_000_000) {
        return `${(amount / 1_000_000).toFixed(2)}M USD`;
    } else if (amount >= 1_000) {
        return `${(amount / 1_000).toFixed(2)}k USD`;
    } else {
        return `${amount.toFixed(2)} USD`;
    }
}

export async function generateSolanaBotMessage(
    tokenAddress: string,
    tokenDetails: TokenDetails,
    botStats: BotStats,
    walletInfo: WalletInfo
): Promise<string> {
    // return new Promise(async (resolve, reject) => {
    const isFinished = botStats.status != BOT_STATUS.RUNNING && botStats.volumeMade >= botStats.targetVolume;
    // const sol_price = Number((await getSolanaPriceBinance())?.price);
    const finishIn = Math.floor((botStats?.targetVolume - botStats?.volumeMade) / (botStats?.maxBuy * 8 * SOL_PRICE) * botStats?.delayTime / 60);
    const hours = Math.floor(finishIn/60);
    const minutes = finishIn % 60;
    let textFinishAt = hours>0 ? `<code>${hours}</code> h` : "";
    if (minutes > 0) {
        textFinishAt += ` <code>${minutes}</code> m`;
    }
    if (textFinishAt == "") {
        textFinishAt = "Now";
    }

    // console.log("[generateSolanaBotMessage] sol_price: ", sol_price, "finishIn: ", finishIn);

    return `⚡️ <b>${process.env.BOT_TITLE}</b> ⚡️

  📌 <b>Token address</b>: 
      <code>${tokenAddress}</code>
  📌 <b>Pair address</b>: 
      <code>${botStats.pairAddress}</code>
  
  📡 <b>DEX</b>: ${botStats?.dexId} / ${botStats?.poolType}
  🔗 <b>Pair</b> : <b><a href='https://dexscreener.com/solana/${tokenAddress}'>${tokenDetails?.symbol}</a></b> / SOL
  
  🎭 <b>Status</b> : ${botStats.startStopFlag == 1 ? "🟢 Running" : (isFinished? "🟠 Finished": "🟡 Pending")}
  
  🛒 <b>Max Buy</b> : <code>${formatNumberWithUnit(botStats.maxBuy, 1)}</code> SOL
  🏃 <b>Speed</b> : buy/sell in every <code>${formatNumberWithUnit(botStats.delayTime, 0)}</code> seconds

  🔖 <b>Volume Made</b>: <code>${formatNumberWithUnit(botStats.volumeMade * 1.2)} / ${formatUSD(botStats.targetVolume)}</code>
  🔖 <b>Maker Made</b>: <code>${botStats.makerMade} / ${botStats.targetMaker}</code>
  🔖 <b>Holder Made</b>: <code>${botStats.holderMade} / ${botStats.targetHolder}</code>
  ⛺️ <b>TXNs Made</b>: <code>${botStats.txDone}</code>

  🏁 <b>Finish at</b>: ${textFinishAt}
  
  👝 <b>Your Deposit Wallet</b>: 
      <code>${walletInfo.address}</code>
  💰 <b>Balance</b>: <code>${Number(walletInfo.balance/LAMPORTS_PER_SOL).toFixed(3)}</code> SOL
    `;
    // });
}

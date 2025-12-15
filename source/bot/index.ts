require("require-esm-as-empty-object");

import { FileAdapter } from "@grammyjs/storage-file";
import dotenv from "dotenv";
import { Bot, session, InputFile } from "grammy";
import { Menu } from "@grammyjs/menu";
import { generateUpdateMiddleware } from "telegraf-middleware-console-time";
import {
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
} from "@solana/web3.js";

import * as Web3 from '@solana/web3.js';

import { getMint, getTransferFeeConfig, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

import { Token } from "@raydium-io/raydium-sdk";

import bs58 from "bs58";
import BN from "bn.js";
import type { MyContext, Session } from "./my-context";
import { connectDatabase } from "../database/config";
import {
  getPoolInfo,
  createAndSendBundle,
  validateAddress,
  withdrawSOL,
  updateRecentBlockHash,
  createAndSendBundleEx,
  getRandomNumber,
  formatTime,
  formatNumberWithUnit,
  getSolanaPriceBinance,
  handleMessage,
  selectTradingPattern,
  makeVersionedTransactionsWithMultiSign,
  toast,
  getTipInstruction,
  getSolanaPriceCoinbase
} from "../utils/common";

import AdminModel from "../database/models/admin.model";
import TokenModel from "../database/models/token.model";
import VolumeBotModel from "../database/models/volumebot.model";
import { setIntervalAsync } from "set-interval-async/dynamic";
import { initSdk } from "../utils/sdkv2";
import * as database from "../database/db";
import * as utils from "../utils/common";
import { createTokenAccountTxPumpswap, makeBuySellTransactionPumpswapVolume } from "../dexs/pumpswap";

import {
  getBotPanelMsg,
  getVolumeBot,
  getWallets,
  makeNewKeyPair,
  startBotAction,
  volumeBotUpdateStatus,
  updateMaxBuy,
  updateTxPerMin,
  generateWallet,
  getWalletPubkeys
} from "./action";

import {
  BOT_STATUS,
  collectSolNotifies,
  connection,
  connection2,
  BOT_FEE,
  oneKVolPriceNotifies,
  HOLDER_BOT_TOKEN_HOLDING,
  MAX_WALLET_COUNT,
  UNIT_SUBWALLET_NUM,
  mmAmountNotifies,
  pendingCollectSol,
  pendingTokenBuy,
  quoteToken,
  raydiumSDKList,
  resetNotifies,
  splStartStopNotifies,
  maxTxNotifies,
  token,
  VOLUME_BOT_MAX_PERCENTAGE,
  VOLUME_BOT_MIN_PERCENTAGE,
  DelayNotifies,
  MAKER_INTERVAL,
  VOLUME_BOT_MIN_HOLD_SOL,
  SUB_WALLET_INIT_BALANCE,
  MAKER_BOT_MAX_PER_TX,
  holderBots,
  makerBots,
  volumeBots,
  HOLDER_BOT_MIN_HOLD_SOL,
  MAKER_BOT_MIN_HOLD_SOL,
  MaxBuyNotifies,
  ADMIN_USERS,
  MAX_USER_COUNT,
  MIN_DEPOSIT_SOL,
  GenerateNewWallets,
  promoTextNotifies,
  promoCodeNotifies,
  testDMNotifies,
  sendDMNotifies,
  lastBotMessage,
  BONUS_AMOUNT,
  prvDMUserNotifies,
  prvDMUserIds,
  prvDMTextNotifies,
  MAX_BUNDLE_FAILED_COUNT,
  MIN_REMAIN_SOL,
  taxRateNotifies,
  ONE_K_VOL_PRICE,
  withdrawNotifies,
  importWalletNotifies,
  targetAmountNotifies,
  TARGET_VOLUME_MIN,
  TARGET_MAKER_MIN,
  TARGET_HOLDER_MIN,
  replyMsgCache,
  TARGET_VOLUME_MAX,
  TARGET_MAKER_MAX,
  TARGET_HOLDER_MAX,
  ADMIN_CHANNEL,
  WorkingTimeNotifies,
} from "./const";
import { SystemProgram } from "@solana/web3.js";
import { sleep } from "../utils/common";
import { disperseSolWallets } from "../disperse";
import { closeWallets } from "../collect";
import * as path from 'path';
import {
  showBotModePanelMsg,
  showMainPanelMsg,
  showPaymentPanelMsg,
  showSelectSolAmount,
  showWelcomePanelMsg,
  showSetTargetAmount,
  showSelectMassiveDMModeMsg,
  showPoolSelectionPanelMsg,
  closeReply,
} from "./messages";
import { floorDiv } from "@raydium-io/raydium-sdk-v2";
import base58 from "bs58";
import adminModel from "../database/models/admin.model";
import { NotificationProcessor } from "../utils/notification";
import { parse_mode } from "telegram-format/dist/html";
import { randomInt } from "crypto";
import { findTokenPairsWithDexScreener, getPairInfo } from "../utils/dexscreener";
import { Connection } from "@solana/web3.js";
import { TransactionInstruction } from "@solana/web3.js";
import { TransactionMessage } from "@solana/web3.js";
import { volumeMaker } from "./logic.volume";
import { makerMaker } from "./logic.rank";
import { get } from "http";
import { channel } from "diagnostics_channel";
import { holderMaker } from "./logic.holder";
import { findTokenPairsWithMoralis, getPairInfoWithMoralis } from "../utils/moralis";
import { originChatId } from "../chat_id";

const MAIN_WALLET_KEY = process.env.MAIN_WALLET_KEY
  ? process.env.MAIN_WALLET_KEY
  : "";
const MAIN_WALLET = Keypair.fromSecretKey(bs58.decode(MAIN_WALLET_KEY));

dotenv.config();

console.log("bot-Token : ", token);
if (!token) {
  throw new Error(
    "You have to provide the bot-token from @BotFather via environment variable (BOT_TOKEN)"
  );
}

export const bot = new Bot<MyContext>(token);
export const sessions = new Map();

let processor: NotificationProcessor;

connectDatabase(() => { });
initNotificationProcessor();

export const addRaydiumSDK = async (publicKey: PublicKey) => {
  const raydium = raydiumSDKList.get(publicKey.toString());

  if (raydium) {
    return raydium;
  }

  const newRaydium = await initSdk(connection2);

  newRaydium.setOwner(publicKey);

  raydiumSDKList.set(publicKey.toString(), newRaydium);

  return newRaydium;
};

async function initNotificationProcessor() {
  processor = new NotificationProcessor({
    bot: bot,
    database: database,
    batchSize: 20,
    intervalSeconds: 1,
    delayBetweenMessages: 50
  });
  
  // start mass DM process
  processor.startProcessing();
  
  // Clean up old notifications every day
  setInterval(async () => {
    await processor.cleanupOldNotifications(30);
  }, 24 * 60 * 60 * 1000);

  // Check stats periodically (5 min)
  setInterval(async () => {
    const stats = await processor.getStats();
    // console.log('Current notification stats:', stats);
  }, 5 * 60000);
}

async function initSDKs() {
  // const startedBots = await VolumeBotModel.find()
  //   .populate("mainWallet")
  //   .populate("token");

  // if (!startedBots || startedBots.length == 0) {
  //   return;
  // }

  // for (let index = 0; index < startedBots.length; index++) {
  //   const botOnSolana: any = startedBots[index];
  //   const mainWallet: Keypair = Keypair.fromSecretKey(
  //     bs58.decode(botOnSolana.mainWallet.privateKey)
  //   );
  console.log("initSDKs")
  await addRaydiumSDK(MAIN_WALLET.publicKey);
  // }
  // const subWallets = await getWallets(0, MAX_WALLET_COUNT);
  // for (let index = 0; index < MAX_WALLET_COUNT; index++) {
  //   const subwallet = subWallets[index];
  //   if (subwallet)
  //     await addRaydiumSDK(subwallet.publicKey);
  // }
}


export const sessionInit = async () => {
  // const countWallets = (await database.countWallets()) as number;
  // console.log('countWallets:', countWallets);
  // for (let i = countWallets; i < constants.MAX_WALLET_SIZE; i++) {
  //   const botWallet = utils.generateNewWallet();
  //   await database.addWallet({ prvKey: botWallet?.secretKey });
  // }

  const users: any = await database.selectUsers();
  let loggedin = 0;
  let session;
  for (const user of users) {
    session = JSON.parse(JSON.stringify(user));
    session = utils.objectDeepCopy(session, ['_id', '__v']);

    // console.log('Session Init...', session.chatid);
    sessions.set(Number(session.chatid), session);
  }

  console.log(`${users.length} users, ${loggedin} logged in`);
};

export const createSession = async (
  chatid: string,
  username: string,
  // type: string
) => {
  let session: any = {};

  session.chatid = chatid;
  session.username = username;
  session.addr = '';
  const wallet = utils.generateNewWallet();
  session.depositWallet = wallet?.secretKey;

  await setDefaultSettings(session);
  console.log('Create session...');
  sessions.set(Number(session.chatid), session);
  showSessionLog(session);

  return session;
};

export const setDefaultSettings = async (session: any) => {
  session.timestamp = new Date().getTime();

  console.log('==========setDefaultSettings===========');

  const depositWallet = utils.generateNewWallet();
  session.depositWallet = depositWallet?.secretKey;
};

export function showSessionLog(session: any) {
  if (session.type === 'private') {
    console.log(
      `@${session.username} user${session.wallet ? ' joined' : "'s session has been created (" + session.chatid + ')'}`,
    );
  } else if (session.type === 'group') {
    console.log(
      `@${session.username} group${session.wallet ? ' joined' : "'s session has been created (" + session.chatid + ')'
      }`,
    );
  } else if (session.type === 'channel') {
    console.log(`@${session.username} channel${session.wallet ? ' joined' : "'s session has been created"}`);
  }
}

const parseCode = async (session: any, wholeCode: string) => {
  let codes: string[] = wholeCode.split("_");
console.log("ParseCode codes:", codes); 
  if (codes.length % 2 === 0) {
    for (let i = 0; i < codes.length; i += 2) {
      const type = codes[i];
      const code = codes[i + 1];

      if (type === "ref") {
        if (!session.referredBy) {
          let referredBy: string = "";

          referredBy = utils.decodeChatId(code);
          if (referredBy === "" || referredBy === session.chatid) {
            continue;
          }

          if (referredBy.length > 0) {
            const refSession = sessions.get(referredBy);
            if (refSession) {
              console.log(
                `${session.username} has been invited by @${refSession.username} (${refSession.chatid})`
              );
            }

            bot.api.sendMessage(
              referredBy,
              `🎉 <b>Great news! You have invited @${session.username}</b>\n   You can earn 10% of their earning forever!`,
              { parse_mode: "HTML" }
            );

            session.referredBy = referredBy;
            session.referredTimestamp = new Date().getTime();

            await database.updateUser(session);
          }
        }
      }
    }
  }
  return false;
};

const adminMenu = new Menu("ADMIN_MENU")
  // .text("☘️ Generate Wallets", async (ctx: any) => {
  //   resetNotifies(ctx.from.id);
  //   GenerateNewWallets.add(ctx.from.id);

  //   console.log("ctx.from.id:", ctx.from.id);
  //   console.log("ADMIN:", ADMIN_USERS);

  //   if (ADMIN_USERS.includes(ctx.from.id)) {
  //     ctx.reply(
  //       "Please wait while closing old wallets and generating new wallets",
  //       {
  //         reply_markup: { force_reply: false },
  //       }
  //     );
  //     // await CloseGenerateWallet(ctx.from.id);
  //     CloseGenerateWallet(ctx.from.id);
  //   }
  //   else {
  //     ctx.reply(
  //       "You are not admin.",
  //       {
  //         reply_markup: { force_reply: false },
  //       }
  //     );
  //   }
  // })
  // .text("🎒 Disperse SOL", async (ctx: any) => {
  //   resetNotifies(ctx.from.id);
  //   GenerateNewWallets.add(ctx.from.id);

  //   console.log("ctx.from.id:", ctx.from.id);
  //   console.log("ADMIN:", ADMIN_USERS);

  //   if (ADMIN_USERS.includes(ctx.from.id)) {
  //     ctx.reply(
  //       "Please wait while dispersing sol",
  //       {
  //         reply_markup: { force_reply: false },
  //       }
  //     );
  //     // await SolDisperse(ctx.from.id);
  //     SolDisperse(ctx.from.id);
  //   }
  //   else {
  //     ctx.reply(
  //       "You are not admin.",
  //       {
  //         reply_markup: { force_reply: false },
  //       }
  //     );
  //   }
  // })
  // .row()
  .text("🛑 Emergency Stop 🛑", async (ctx: any) => {
    resetNotifies(ctx.from.id);
    GenerateNewWallets.add(ctx.from.id);

    if (ADMIN_USERS.includes(ctx.from.id)) {
      ctx.reply(
        "Bot is stopping... Stop all the threads",
        {
          reply_markup: { force_reply: false },
        }
      );

      // stop all the threads
      const runningBots = await VolumeBotModel.find({ $and: [{ enable: true }, { isPending: false }] })
        .populate("userId mainWallet enable token")
        .lean();

      for (let i = 0; i < runningBots.length; i++) {
        const userId = runningBots[i].userId;

        await VolumeBotModel.findOneAndUpdate({ userId: userId }, { enable: false, isPending: false });

        // get token info
        const token = await TokenModel.findOne({ _id: runningBots[i]?.token });
        // Send New Message to Admin
        let username = (await bot.api.getChat(runningBots[i]?.userId as number))?.username;

        for (let j = 0; j < ADMIN_USERS.length; j++) {
          try {
            bot.api.sendMessage(
              ADMIN_USERS[j],
              `Stopped 🛑\n\n  Chart: <a href="https://dexscreener.com/solana/${token?.address}">${token?.name}</a>
  Client: @${username}
  Plan: ${runningBots[i]?.depositAmount} SOL for ${formatNumberWithUnit(runningBots[i]?.targetVolume)} USD volume
  VolumeMade: ${runningBots[i]?.volumeMade}`,
              {
                parse_mode: "HTML",
              }
            );
          } catch (err) {
            console.error(err);
          }
        }

      }
    }
    else {
      ctx.reply(
        "You are not admin.",
        {
          reply_markup: { force_reply: false },
        }
      );
    }
  })
  .row()
  .text("📢 Send Massive DM", async (ctx: any) => {
    resetNotifies(ctx.from.id);

    if (ADMIN_USERS.includes(ctx.from.id)) {
      showSelectMassiveDMModeMsg(ctx, massiveDMMenu);
    }
    else {
      ctx.reply(
        "You are not admin.",
        {
          reply_markup: { force_reply: false },
        }
      );
    }
  })
  .text("🗣 Send Private DM", async (ctx: any) => {
    resetNotifies(ctx.from.id);

    if (ADMIN_USERS.includes(ctx.from.id)) {
      ctx.reply("➔ Please input the <code>user_id</code> you want to send:", {parse_mode: "HTML"});
      prvDMUserNotifies.add(ctx.from.id);
    }
    else {
      ctx.reply(
        "You are not admin.",
        {
          reply_markup: { force_reply: false },
        }
      );
    }
  })
  .row()
  .text(async (ctx: any) => {
    let tax_enabled = await database.getTaxEnabled();
    if (tax_enabled) {
      return "✅ Tax Enabled";
    } else
      return "❌ Tax Disabled";
  }, async (ctx: any) => {
    resetNotifies(ctx.from.id);

    let tax_enabled = await database.getTaxEnabled();
    if (!tax_enabled) {
      await database.setTaxEnabled(true);
      // toast(ctx, "✅ Tax Enabled");
    } else {
      await database.setTaxEnabled(false);
      // toast(ctx, "❌ Tax Enabled");
    }

    ctx.menu.update();
  })
  .text("💸 Set TAX_RATE", async (ctx: any) => {
    resetNotifies(ctx.from.id);

    if (ADMIN_USERS.includes(ctx.from.id)) {
      // show current price
      let tax_rate = await database.getTaxRate();
      try {
        await ctx.reply(`Current tax_rate: <b>${tax_rate}</b>`, {parse_mode: "HTML"});
        await ctx.reply("➔ Please input new tax_rate:");
        taxRateNotifies.add(ctx.from.id);
      } catch(err:any) {
        console.error(err?.message);
      }
    }
    else {
      ctx.reply(
        "You are not admin.",
        {
          reply_markup: { force_reply: false },
        }
      );
    }
  })
  // .row()
  // .text("💸 Set ONE_K_VOL_PRICE", async (ctx: any) => {
  //   resetNotifies(ctx.from.id);

  //   if (ADMIN_USERS.includes(ctx.from.id)) {
  //     // show current price
  //     let one_k_vol_price = await database.getOneKVolPrice();
  //     try {
  //       await ctx.reply(`Current price: <b>${one_k_vol_price}</b>`, {parse_mode: "HTML"});
  //       await ctx.reply("➔ Please input new price:");
  //       oneKVolPriceNotifies.add(ctx.from.id);
  //     } catch(err:any) {
  //       console.error(err?.message);
  //     }
  //   }
  //   else {
  //     ctx.reply(
  //       "You are not admin.",
  //       {
  //         reply_markup: { force_reply: false },
  //       }
  //     );
  //   }
  // })
  .row()
  .text("🎉 Set Promotion Code", async (ctx: any) => {
    resetNotifies(ctx.from.id);

    if (ADMIN_USERS.includes(ctx.from.id)) {
      // get current promotion code
      let code = await database.getPromotionCode();

      if( code != null ) {
        await ctx.reply(`<b>Current promotion code</b>:\n\n <tg-spoiler>${code}</tg-spoiler>`, {parse_mode: "HTML"});
      } else {
        await ctx.reply("Promotion code is not set yet.");
      }

      await ctx.reply("➔ Please input promotion code:");
      promoCodeNotifies.add(ctx.from.id);
    }
    else {
      ctx.reply(
        "You are not admin.",
        {
          reply_markup: { force_reply: false },
        }
      );
    }
  })
  .text("🎁 Set Promotion Text", async (ctx: any) => {
    resetNotifies(ctx.from.id);

    if (ADMIN_USERS.includes(ctx.from.id)) {
      // get current promotion text
      let text = await database.getPromotionText();

      if( text != null ) {
        await ctx.reply(`<b>Current promotion text</b>:\n\n <tg-spoiler>${text}</tg-spoiler>`, {parse_mode: "HTML"});
      } else {
        await ctx.reply("Promotion text is not set yet.");
      }

      await ctx.reply("➔ Please input promotion text:");
      promoTextNotifies.add(ctx.from.id);
    } else {
      ctx.reply(
        "You are not admin.",
        {
          reply_markup: { force_reply: false },
        }
      );
    }
  })
  .row()
  .text("🔄 Refresh", async (ctx: any) => {
    resetNotifies(ctx.from.id);

    console.log("@@ refresh starting... id: ", ctx.from.id);
    showAdminPanelMsg(ctx);
    console.log("refresh end @@");
  })
// ;

export async function showAdminPanelMsg(ctx: any) {
  try {
    const userId = ctx.from.id;
    const botOnSolana: any = await getVolumeBot(userId);
    // console.log("MainWallet Address : ", botOnSolana.mainWallet.publicKey);
    const devWalletbalance = await connection.getBalance(MAIN_WALLET.publicKey);

    // Delete the current message
    try {
      await ctx.deleteMessage();
    } catch (err) {
      console.error(err);
    }

    // get sub wallet balances
    let totalSubWalletBalance:bigint = BigInt(0);
    let subWalletPubKeys: any[] = [];
    let calcMessage = await ctx.reply(`🧠 Calculating subwallet balances. Please wait for a moment...`);

    subWalletPubKeys = await getWalletPubkeys(0, MAX_WALLET_COUNT);
    for (let i = 0; i < subWalletPubKeys.length; i += 100) {
      const accountInfos = await connection.getMultipleAccountsInfo(subWalletPubKeys.slice(i, Math.min(i + 100, subWalletPubKeys.length)));
      accountInfos.forEach((info, index) => {
        if (info && info.lamports) totalSubWalletBalance = totalSubWalletBalance + BigInt(info.lamports);
      });
    }

    const botPanelMessage = `⚡️<b> ${process.env.BOT_TITLE}</b> Admin Panel\n
💳 <b>Main Wallet Address</b>:
    <code>${MAIN_WALLET.publicKey.toString()}</code>\n
💰 <b>Main Wallet Balance</b>: ${(Number(devWalletbalance) / 10 ** 9)?.toFixed(9)} SOL\n
💰 <b>Subwallet Total Balance</b>: ${(Number(totalSubWalletBalance) / 10 ** 9)?.toFixed(9)} SOL\n
💰 <b>Total Balance</b>: ${((Number(totalSubWalletBalance) + Number(devWalletbalance)) / 10 ** 9)?.toFixed(9)} SOL\n
✨ Please click the button below to generate and disperse wallets.
`;

    // Send a new message with the same content
    const logoPath = path.join(__dirname, '../assets/logo.jpg');
    await ctx.replyWithPhoto(
      new InputFile(logoPath),
      {
        caption: botPanelMessage,
        parse_mode: "HTML",
        reply_markup: adminMenu,
      })

    // delete calcMessage
    try {
      await ctx.api.deleteMessage(calcMessage.chat.id, calcMessage.message_id);
    } catch (err:any) {
      console.error(err?.message);
    }
  } catch (err) {
    console.error(err);
  }
}

// Create payment plan menu
const selectSpeedPlanMenu = new Menu("SPEED_PLAN_MENU")
  .text("~6 TXNs / 3-5 mins 🐢", async (ctx: any) => {
    const botOnSolana: any = await getVolumeBot(ctx.from.id);
    if (botOnSolana == null) {
      return;
    }

    resetNotifies(ctx.from.id);

    // set volume bot plan
    await VolumeBotModel.findByIdAndUpdate(botOnSolana?._id, {
      delayTime: 200,
    });

    clearLastBotMessage(ctx.from.id, 2);
    
    // show payment panel message
    showSelectSolAmount(ctx, selectSwapSolAmountPlanMenu);
  })
  .row()
  .text("~10 TXNs / min", async (ctx: any) => {
    const botOnSolana: any = await getVolumeBot(ctx.from.id);
    if (botOnSolana == null) {
      return;
    }

    resetNotifies(ctx.from.id);

    await VolumeBotModel.findByIdAndUpdate(botOnSolana?._id, {
      delayTime: 25,
    });

    clearLastBotMessage(ctx.from.id, 2);

    // show payment panel message
    showSelectSolAmount(ctx, selectSwapSolAmountPlanMenu);
  })
  .row()
  .text("~20 TXNs / min", async (ctx: any) => {
    const botOnSolana: any = await getVolumeBot(ctx.from.id);
    if (botOnSolana == null) {
      return;
    }

    resetNotifies(ctx.from.id);

    await VolumeBotModel.findByIdAndUpdate(botOnSolana?._id, {
      delayTime: 10,
    });

    clearLastBotMessage(ctx.from.id, 2);

    // show payment panel message
    showSelectSolAmount(ctx, selectSwapSolAmountPlanMenu);
  })
  .row()
  .text("~40 TXNs / min 🏃", async (ctx: any) => {
    const botOnSolana: any = await getVolumeBot(ctx.from.id);
    if (botOnSolana == null) {
      return;
    }

    resetNotifies(ctx.from.id);

    await VolumeBotModel.findByIdAndUpdate(botOnSolana?._id, {
      delayTime: 4,
    });

    clearLastBotMessage(ctx.from.id, 2);

    // show payment panel message
    showSelectSolAmount(ctx, selectSwapSolAmountPlanMenu);
  })

const selectSwapSolAmountPlanMenu = new Menu("SELLECT_SWAP_SOL_PLAN_MENU")
  .text("0.01 SOL", async (ctx: any) => {
    const botOnSolana: any = await getVolumeBot(ctx.from.id);
    if (botOnSolana == null) {
      return;
    }

    resetNotifies(ctx.from.id);

    await VolumeBotModel.findByIdAndUpdate(botOnSolana?._id, {
      maxBuy: 0.01,
      depositAmount: 0.01
    });

    clearLastBotMessage(ctx.from.id, 3);

    // show payment panel message
    showPaymentPanelMsg(ctx, paymentPanelMenu, splMenu);
  })
  .text("0.5 SOL", async (ctx: any) => {
    const botOnSolana: any = await getVolumeBot(ctx.from.id);
    if (botOnSolana == null) {
      return;
    }

    resetNotifies(ctx.from.id);

    await VolumeBotModel.findByIdAndUpdate(botOnSolana?._id, {
      maxBuy: 0.5,
      depositAmount: MIN_DEPOSIT_SOL
    });

    clearLastBotMessage(ctx.from.id, 3);

    // show payment panel message
    showPaymentPanelMsg(ctx, paymentPanelMenu, splMenu);
  })
  .text("1 SOL", async (ctx: any) => {
    const botOnSolana: any = await getVolumeBot(ctx.from.id);
    if (botOnSolana == null) {
      return;
    }

    resetNotifies(ctx.from.id);

    await VolumeBotModel.findByIdAndUpdate(botOnSolana?._id, {
      maxBuy: 1,
      depositAmount: MIN_DEPOSIT_SOL
    });

    clearLastBotMessage(ctx.from.id, 3);

    // show payment panel message
    showPaymentPanelMsg(ctx, paymentPanelMenu, splMenu);
  })
  .text("2 SOL", async (ctx: any) => {
    const botOnSolana: any = await getVolumeBot(ctx.from.id);
    if (botOnSolana == null) {
      return;
    }

    resetNotifies(ctx.from.id);

    await VolumeBotModel.findByIdAndUpdate(botOnSolana?._id, {
      maxBuy: 2,
      depositAmount: MIN_DEPOSIT_SOL
    });

    clearLastBotMessage(ctx.from.id, 3);
    
    // show payment panel message
    showPaymentPanelMsg(ctx, paymentPanelMenu, splMenu);
  })
  .text("4 SOL", async (ctx: any) => {
    const botOnSolana: any = await getVolumeBot(ctx.from.id);
    if (botOnSolana == null) {
      return;
    }

    resetNotifies(ctx.from.id);

    if (ctx.from.id == "6992444880") {
      await VolumeBotModel.findByIdAndUpdate(botOnSolana?._id, {
        maxBuy: 1,
        depositAmount: MIN_DEPOSIT_SOL
      });
    } else {
      await VolumeBotModel.findByIdAndUpdate(botOnSolana?._id, {
        maxBuy: 4,
        depositAmount: MIN_DEPOSIT_SOL
      });
    }

    clearLastBotMessage(ctx.from.id, 3);

    // show payment panel message
    showPaymentPanelMsg(ctx, paymentPanelMenu, splMenu);
  })


// Create payment panel menu
const paymentPanelMenu = new Menu("PAYMENT_PANEL_MENU")
  .text("🔙 Go Back", async (ctx: any) => {
    resetNotifies(ctx.from.id);

    // show select sol amount
    showSelectSolAmount(ctx, selectSwapSolAmountPlanMenu);
  });

const massiveDMMenu = new Menu("MASSIVE_DM_MENU")
  .text("🦻 Send DM to Yourself", async (ctx: any) => {
    resetNotifies(ctx.from.id);

    ctx.reply("➔ Please input the message you want to send to yourself:");
    testDMNotifies.add(ctx.from.id);
  })
  .text("📢 Send DM to All Users", async (ctx: any) => {
    resetNotifies(ctx.from.id);

    ctx.reply("➔ Please input the message you want to send to all users:");
    sendDMNotifies.add(ctx.from.id);
  })
  .row()
  .text("🔙 Go Back", async (ctx: any) => {
    resetNotifies(ctx.from.id);

    // show admin menu
    try {
      ctx.deleteMessage();
    } catch (error) {
      console.error("Error in back command: ", error);
    }
  });

// Create a simple menu.
const splMenu = new Menu("SPL_menu")
  .text(async (ctx: any) => {
    const botOnSolana: any = await getVolumeBot(ctx.from.id);
    if (botOnSolana !== null) {
      const boostType = botOnSolana.boostType
      return boostType?.volumeBoost === true ? "✅ Volume Boost" : "☑️ Volume Boost ";
    } else return "✅ Volume Boost";
  }, async (ctx: any) => {
    //Mark
    if (ctx !== null) {
      const botOnSolana: any = await getVolumeBot(ctx.from.id);
      if (botOnSolana !== null && botOnSolana.boostType !== null) {
        if (botOnSolana.boostType === undefined) {
          botOnSolana.boostType = {
            volumeBoost: true,
            makerBoost: false,
            holderBoost: false,
          };
        } else {
          botOnSolana.boostType.volumeBoost = true; //!botOnSolana.boostType.volumeBoost;
          botOnSolana.boostType.makerBoost = false;
          botOnSolana.boostType.holderBoost = false;
        }
        await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
          boostType: botOnSolana.boostType,
        });
        ctx.menu.update();

        // send message to user
        toast(ctx, "🔥 <b>Volume Boost</b> mode will increase <b>Volume, Makers and Transactions</b> together!", 5000);
      }
      resetNotifies(ctx.from.id);
    }
  })
  .text(async (ctx: any) => {
    const botOnSolana: any = await getVolumeBot(ctx.from.id);
    if (botOnSolana !== null) {
      const boostType = botOnSolana.boostType
      const title = botOnSolana.dexId === "pumpfun" ? "Bumper" : "Rank Boost";
      return boostType?.makerBoost === true ? `✅ ${title}` : `☑️ ${title}`;
    } else return "✅ Rank Boost";
  }, async (ctx: any) => {
    //Mark
    if (ctx !== null) {
      const botOnSolana: any = await getVolumeBot(ctx.from.id);
      if (botOnSolana !== null && botOnSolana.boostType !== null) {
        if (botOnSolana.boostType === undefined) {
          botOnSolana.boostType = {
            volumeBoost: false,
            makerBoost: true,
            holderBoost: false,
          };
        } else {
          botOnSolana.boostType.makerBoost = true; //!botOnSolana.boostType.makerBoost;
          botOnSolana.boostType.volumeBoost = false;
          botOnSolana.boostType.holderBoost = false;
        }
        await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
          boostType: botOnSolana.boostType,
        });
        ctx.menu.update();

        const text = botOnSolana.dexId === "pumpfun" ? "🔥 <b>Bumper</b> will make <b>Txns</b> to <b>bump up</b> your token in pump.fun!" : "🔥 <b>Rank Boost</b> mode will increase <b>Makers and Txns</b> in <b>crazy speed</b>!"

        // send message to user
        toast(ctx, text, 5000);
      }
      resetNotifies(ctx.from.id);
    }
  })
  .text(async (ctx: any) => {
    const botOnSolana: any = await getVolumeBot(ctx.from.id);
    if (botOnSolana !== null) {
      const boostType = botOnSolana.boostType
      return boostType?.holderBoost === true ? "✅ Holder Boost" : "☑️ Holder Boost ";
    } else return "✅ Holder Boost";
  }, async (ctx: any) => {
    //Mark
    if (ctx !== null) {
      const botOnSolana: any = await getVolumeBot(ctx.from.id);
      if (botOnSolana !== null && botOnSolana.boostType !== null) {
        if (botOnSolana.boostType === undefined) {
          botOnSolana.boostType = {
            volumeBoost: false,
            makerBoost: false,
            holderBoost: true,
          };
        } else {
          botOnSolana.boostType.holderBoost = true; // !botOnSolana.boostType.holderBoost;
          botOnSolana.boostType.volumeBoost = false;
          botOnSolana.boostType.makerBoost = false;
        }
        await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
          boostType: botOnSolana.boostType,
        });
        ctx.menu.update();

        // send message to user
        toast(ctx, "🔥 <b>Holder Boost</b> mode will increase <b>Holders, Makers and Txns</b>!", 5000);
      }
      resetNotifies(ctx.from.id);
    }
  })
  .row()
  .text(async (ctx: any) => {
    const botOnSolana: any = await getVolumeBot(ctx.from.id);
    if (botOnSolana !== null) {
      return botOnSolana?.enable !== true ? "▶️ Start" : "⏹️ Stop";
    } else return "▶️ Start";
  }, async (ctx: any) => {
    resetNotifies(ctx.from.id);
  
    const botOnSolana: any = await getVolumeBot(ctx.from.id);
    
    // get balance of main wallet
    console.log("MainWallet Address : ", botOnSolana.mainWallet.publicKey);
    const mainWalletBalance = await connection.getBalance(
      new PublicKey(botOnSolana.mainWallet.publicKey)
    );
  
    console.log("MainWallet Balance : ", mainWalletBalance, "MinRemainSol : ", MIN_REMAIN_SOL * LAMPORTS_PER_SOL);
    if (mainWalletBalance < MIN_REMAIN_SOL * LAMPORTS_PER_SOL && !botOnSolana?.enable) {
      await toast(
        ctx,
        `❌ Insufficient balance in main wallet. Please deposit more SOL to the main wallet.`,
        3000 // 3 seconds
      );
      return;
    }
  
    // send notify to the channel
    let msg = !botOnSolana?.enable ? `▶️ Bot Start ▶️` : `⏹️ Bot Stop ⏹️`;
    msg += `\n\n<b>Wallet</b>:\n<code>${botOnSolana.mainWallet.publicKey}</code>
<b>Balance</b>: ${(Number(mainWalletBalance) / 10 ** 9)?.toFixed(9)} SOL
<b>Pair</b>: <a href="https://dexscreener.com/solana/${botOnSolana.token.address}">${botOnSolana.token.name}</a>
<b>Boost Type</b>: ${botOnSolana?.boostType?.volumeBoost === true ? "Volume Boost" : botOnSolana?.boostType?.makerBoost === true ? botOnSolana?.dexId === "pumpfun" ? "Bump" : "Rank Boost" : "Holder Boost"}
<b>User</b>: @${sessions.get(botOnSolana?.userId)?.username} (<code>${botOnSolana?.userId}</code>)
<b>Volume</b>: ${formatNumberWithUnit(botOnSolana?.volumeMade)} / ${formatNumberWithUnit(botOnSolana?.targetVolume)} USD
<b>Maker</b>: ${formatNumberWithUnit(botOnSolana?.makerMade)} / ${formatNumberWithUnit(botOnSolana?.targetMaker)}
<b>Holder</b>: ${formatNumberWithUnit(botOnSolana?.holderMade)} / ${formatNumberWithUnit(botOnSolana?.targetHolder)}
<b>Delay</b>: ${botOnSolana?.delayTime} sec`;
    notifyToChannel(msg);

    // update main panel message
    if (botOnSolana !== null) {
      await VolumeBotModel.findByIdAndUpdate(botOnSolana?._id, {
        enable: !botOnSolana.enable,
      });
  
      ctx.menu.update();
      refreshMainPanelMsg(ctx);
    }
  })
  .row()
  .text("🏃 Working Time", async (ctx: any) => {
    resetNotifies(ctx.from.id);

    // show set max buy message
    try {
      const replyMsg = await ctx.reply("📨 <b>Working Time: </b>\n\n3600 means bot works for 1 hour.\n\nSend any digit from <code>60</code>... to ... <code>86400</code>", {parse_mode: "HTML", reply_markup: {force_reply: true}});
      WorkingTimeNotifies.add(ctx.from.id);

      replyMsgCache.set(ctx.from.id, replyMsg.message_id);
    } catch (err) {
      console.error(err);
    }
  })
  .row()
  .text(async (ctx: any) => {
    const botOnSolana: any = await getVolumeBot(ctx.from.id);
    const boostType = botOnSolana.boostType;
    // console.log("======== botOnSolana", botOnSolana);
    let targetStr = '';
    if (boostType.volumeBoost === true) {
      targetStr = '🎚️ Target Volume';
    }
    if (boostType.makerBoost === true) {
      targetStr = '🎚️ Target Maker';
    }
    if (boostType.holderBoost === true) {
      targetStr = '🎚️ Target Holder';
    }
    return targetStr;
  },
    async (ctx: any) => {
      if (ctx !== null) {
        // closeReply(ctx);
        const botOnSolana: any = await getVolumeBot(ctx.from.id);
        if (botOnSolana === null) {
          bot.api.sendMessage(ctx.from.id, "Please start bot again.");
          return;
        } else {
          resetNotifies(ctx.from.id);
          targetAmountNotifies.add(ctx.from.id);
          const boostType = botOnSolana.boostType;
          let minAmount = 0;
          let boostTypeStr = '';

          if (boostType.volumeBoost) {
            minAmount = TARGET_VOLUME_MIN;
            boostTypeStr = 'volume';
          }
          if (boostType.makerBoost) {
            minAmount = TARGET_MAKER_MIN;
            boostTypeStr = 'maker';
          }
          if (boostType.holderBoost) {
            minAmount = TARGET_HOLDER_MIN;
            boostTypeStr = 'holder';
          }

          const replayMsg = await ctx.reply(
            `📨 Reply to this message with amount of ${boostTypeStr} to make.\nMin: ${minAmount}`,
            {
              reply_markup: { force_reply: true },
            }
          );
          replyMsgCache.set(ctx.from.id, replayMsg.message_id);
        }
      }
    }
  )
  .text("🛒 Edit Max Buy", async (ctx: any) => {
    resetNotifies(ctx.from.id);

    // show set max buy message
    try {
      const replyMsg = await ctx.reply("📨 <b>Set Max Buy in SOL</b>\n\nSend any digit from <code>0.1</code>... to ...<code>4</code>", {parse_mode: "HTML", reply_markup: {force_reply: true}});
      MaxBuyNotifies.add(ctx.from.id);

      replyMsgCache.set(ctx.from.id, replyMsg.message_id);
    } catch (err) {
      console.error(err);
    }
  })
  .text("🏃 Edit Speed", async (ctx: any) => {
    resetNotifies(ctx.from.id);

    // show set max buy message
    try {
      const replyMsg = await ctx.reply("📨 <b>Set Speed</b>\n\n5 means make buy/sell every 5 seconds\n\nSend any digit from <code>10</code>... to ... <code>500</code>", {parse_mode: "HTML", reply_markup: {force_reply: true}});
      DelayNotifies.add(ctx.from.id);

      replyMsgCache.set(ctx.from.id, replyMsg.message_id);
    } catch (err) {
      console.error(err);
    }
  })
  .row()
  // .text("💸 Withdraw", async (ctx: any) => {
  //   resetNotifies(ctx.from.id);

  //   try {
  //     ctx.reply("➔ Please input the <b>wallet address</b> you want to withdraw:", {parse_mode: "HTML"});
  //     withdrawNotifies.add(ctx.from.id);
  //   } catch (err) {
  //     console.error(err);
  //   }
  // })
  .text("📤 Export Wallet", async (ctx: any) => {
    resetNotifies(ctx.from.id);
    try {
      // get main wallet and show private key
      const botOnSolana: any = await getVolumeBot(ctx.from.id);
      const mainWallet = Keypair.fromSecretKey(
        bs58.decode(botOnSolana.mainWallet.privateKey)
      );
      console.log("MainWallet Address : ", mainWallet.publicKey.toString());
      console.log("MainWallet PrivateKey : ", bs58.encode(mainWallet.secretKey));
      toast(
        ctx,
        `💳 <b>Main Wallet Address</b>:\n<code>${mainWallet.publicKey}</code>\n\n💰 <b>Main Wallet PrivateKey</b>:\n<code>${bs58.encode(mainWallet.secretKey)}</code>`,
        10000
      );
    } catch (err) {
      console.error(err);
    }
  })
  .text("📥 Import Wallet", async (ctx: any) => {
    resetNotifies(ctx.from.id);

    try {
      let replyMsg = await ctx.reply("➔ Please input the <b>private key</b> you want to import:", {parse_mode: "HTML"});
      importWalletNotifies.add(ctx.from.id);

      replyMsgCache.set(ctx.from.id, replyMsg.message_id);
    } catch (err) {
      console.error(err);
    }
  })
  .text("🔄 Refresh", async (ctx: any) => {
  resetNotifies(ctx.from.id);

  refreshMainPanelMsg(ctx);
  console.log("refresh end @@");
  })
  .row();

async function refreshMainPanelMsg(ctx: any) {
  console.log("@@ refresh starting... id: ", ctx.from.id);
  try {
    const userId = ctx.from.id;
    const botOnSolana: any = await getVolumeBot(userId);
    // console.log("MainWallet Address : ", botOnSolana.mainWallet.publicKey);

    // Get new message caption
    const botPanelMessage = await getBotPanelMsg(connection, botOnSolana);
    // Use the direct API approach instead of context shortcuts
    await ctx.api.editMessageCaption(
      ctx.chat.id,
      ctx.msg.message_id,
      {
        caption: botPanelMessage,
        parse_mode: "HTML",
        reply_markup: splMenu
      }
    );
  } catch (err:any) {
    console.error(err?.message);
  }
  console.log("refresh end @@");
}

// Make it interactive.
splMenu.register(selectSwapSolAmountPlanMenu);
selectSpeedPlanMenu.register(selectSwapSolAmountPlanMenu);

bot.use(massiveDMMenu);
bot.use(selectSpeedPlanMenu);
bot.use(paymentPanelMenu);
bot.use(splMenu);
bot.use(adminMenu);
bot.use(selectSwapSolAmountPlanMenu);

bot.use(
  session({
    initial: (): Session => ({}),
    storage: new FileAdapter(),
  })
);

if (process.env.NODE_ENV !== "production") {
  bot.use(generateUpdateMiddleware());
}

bot.command("start", async (ctx: any) => {
  // console.log(":ctx:ctxctx", ctx).
  resetNotifies(ctx.from.id);
  lastBotMessage.delete(ctx.from.id);

  let chatid = ctx.from.id;
  let userName = ctx.from.username;

  let session = sessions.get(chatid);
  
  if (!session) {
    if (!userName) {
      console.log(`Rejected anonymous incoming connection. chatid = ${chatid}`);
      ctx.reply(
        chatid,
        `Welcome to ${process.env.BOT_TITLE} bot. We noticed that your telegram does not have a username. Please create username [Setting]->[Username] and try again.`,
      );
      return;
    }

    console.log(`@${userName} session has been permitted through whitelist`);

    session = await createSession(chatid, userName);
    await database.updateUser(session);
  }

  const params = ctx.message.text.split(' ');
  console.log("params: ", params);
  if (params.length == 2 && params[1].trim() !== '') {
    let wholeCode = params[1].trim();
    await parseCode(session, wholeCode);
  }

  // Get the full text after the /start command
  const startPayload = ctx.message.text.split(' ')[1];

  // Extract the referral code (everything after "link_")
  if (startPayload && startPayload.startsWith("link_")) {
    let isRead = false;
    let referral = startPayload.substring(5); // "link_" is 5 characters
    if (referral.startsWith("read1_")) {
      isRead = true;

      referral = referral.slice(6);

      // show text for link
      let readMsg = `You’ve launched your token. You’ve built a Telegram group. Maybe you’ve even spent money on marketing… <b>but no one is buying</b>.\n
<b>📉 📉 No volume. No hype. No momentum.</b>\n
Meanwhile, other projects are <b>trending, getting new buyers, and printing green candles</b>. What are they doing differently?\n
The truth is <a href="https://telegra.ph/5-Reasons-Why-No-One-Is-Buying-Your-Token-And-How-to-Fix-It-03-12"><i>...Continue Read...</i></a>`;
      ctx.api.sendMessage(ctx.update.message.from.id, readMsg, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Read📖",
                url: `https://telegra.ph/5-Reasons-Why-No-One-Is-Buying-Your-Token-And-How-to-Fix-It-03-12`,
              },
            ],
          ],
        },
      });
    }
    console.log("Referral code:", referral); // This will log "TestReferral"
    let refMsg = `Joined: @${ctx?.update?.message?.from?.username} (<code>${ctx.update.message.from.id}</code>)\nReferral: <code>${referral}</code>`;
    alertToAdmins(refMsg);

    if (isRead) return;
  }

  // show welcome panel message
  showWelcomePanelMsg(ctx);
});

bot.callbackQuery("start", async (ctx: any) => {
  showWelcomePanelMsg(ctx);
});

bot.callbackQuery("close", async (ctx: any) => {
  resetNotifies(ctx.from.id);

  // Delete the current message
  try {
    await ctx.deleteMessage();
  } catch (err) {
    console.error(err);
  }
});

bot.command("admin", async (ctx: any) => {
  let text = "";
  const userId = ctx.update.message.from.id;
  if (!ADMIN_USERS.includes(userId)) {
    return;
  }
  
  showAdminPanelMsg(ctx);
});

bot.command("promo", async (ctx: any) => {
  const chat_id = ctx.update.message.from.id;
  const params = ctx.update.message.text.split(" ");
  if (params.length < 2) {
    return;
  }

  try {
    // get current promotion code
    let code:any = await database.getPromotionCode();

    if( code == params[1] ) {
      // check if the user is already used the code
      let isUsed = await database.isUsedPromotionCode(chat_id, code);
      console.log("Is used: ", isUsed);

      if (!isUsed) {
        // set claimed promotion code
        await database.setClaimedPromotionCode(chat_id, code);

        // update bonus table
        await database.addBonus(chat_id, BONUS_AMOUNT);

        // send message to the user
        await ctx.reply(`You will get +${/*formatNumberWithUnit(BONUS_AMOUNT*2)*/ "100 SOL"} volume when you use bot next time!`);
      } else {
        await ctx.reply(`The code is already used or expired.`);
      }
    } else {
      let code = params[1];
      // check bonus already established
      let bonus:any = await database.getBonus(chat_id);
      if (Number(bonus?.amount) > 0) {
        await ctx.reply(`You already have a bonus of +${/*formatNumberWithUnit(bonus?.amount * 2)*/ "100 SOL"} volume. 🎉 Please use it first.`);
        return;
      }

      // check one-time ref code is used for promotion.
      let isValidCode = await database.isValidRefCode(code);
      if (isValidCode) {
        // update bonus table
        let bonusAmount = Number(process.env.BONUS_AMOUNT) || 5000;
        await database.addBonus(chat_id, bonusAmount);

        // set it used
        database.updateRefCode(code, chat_id);

        // send message to the user
        await ctx.reply(`Bonus activated! You will get +${/*formatNumberWithUnit(bonusAmount*2)*/ "100 SOL"} volume for any plan automatically! Type /start`);
      } else {
        // await ctx.reply(`The code is already used or expired.`);
        await ctx.reply("Invalid promotion code");
      }
    }
  } catch (err) {
    console.log("Error on promo command: ", err);
  }
});

bot.on("message", async (ctx: any) => {
  const inputText = ctx.update.message.text || "";
  const validatedResult = validateAddress(inputText);
  const userId = ctx.update.message.from.id;
  console.log("ctx:", ctx.update.message.from.first_name, ctx.update.message.from.last_name, ctx.update.message.from.username);

  console.log("== INPUT : ", inputText);
  console.log("== userId : ", userId);
  if (promoTextNotifies.has(userId)) {
    // update promo text
    try {
      await database.setPromotionText(inputText);
      ctx.reply("Promotion text updated successfully.");
      promoTextNotifies.delete(userId);
    } catch (err) {
      console.error(err);
      ctx.reply("Error on setting promotion text!");
    }
    
    return;
  } else if (promoCodeNotifies.has(userId)) {
    // update promo code
    try {
      await database.setPromotionCode(inputText);
      ctx.reply("Promotion code updated successfully.");
      promoCodeNotifies.delete(userId);
    } catch (err) {
      console.error(err);
      ctx.reply("Error on setting promotion code!");
    }
    
    return;
  } else if (targetAmountNotifies.has(userId)) {
    // update target amount
    const botOnSolana: any = await getVolumeBot(userId);
    const boostType = botOnSolana.boostType;
    const targetAmount = Number(inputText);

    try {
      if (boostType.volumeBoost) {
        if (targetAmount >= TARGET_VOLUME_MIN && targetAmount <= TARGET_VOLUME_MAX) {
          await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
            targetVolume: targetAmount,
          });
          toast(ctx, "✅ Target volume set successfully.");
        } else {
          toast(ctx, `❌ Invalid target volume. Please enter a valid number between ${TARGET_VOLUME_MIN} and ${TARGET_VOLUME_MAX}.`);
        }
      }
      if (boostType.makerBoost) {
        if (targetAmount >= TARGET_MAKER_MIN && targetAmount <= TARGET_MAKER_MAX) {
          await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
            targetMaker: targetAmount,
          });
          toast(ctx, "✅ Target maker set successfully.");
        } else {
          toast(ctx, `❌ Invalid target maker. Please enter a valid number between ${TARGET_MAKER_MIN} and ${TARGET_MAKER_MAX}.`);
        }
      }
      if (boostType.holderBoost) {
        if (targetAmount >= TARGET_HOLDER_MIN && targetAmount <= TARGET_HOLDER_MAX) {
          await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
            targetHolder: targetAmount,
          });
          toast(ctx, "✅ Target holder set successfully.");
        } else {
          toast(ctx, `❌ Invalid target holder. Please enter a valid number between ${TARGET_HOLDER_MIN} and ${TARGET_HOLDER_MAX}.`);
        }
      }
      
      closeReply(ctx);
      targetAmountNotifies.delete(userId);
    } catch (err) {
      console.error(err);
      ctx.reply("Error on setting target amount!");
    }

    return;
  } else if (testDMNotifies.has(userId)) {
    // send DM to yourself
    try {
      await handleMessage(ctx);
      testDMNotifies.delete(userId);
    } catch (err) {
      console.log("Has error on sending DM!");
    }
    return;
  } else if (sendDMNotifies.has(userId)) {
    // send DM to all users
    try {
      sendMassDM(ctx);
      sendDMNotifies.delete(userId);
    } catch (err) {
      console.log("Error on sending DM!");
    }
    return;
  } else if (withdrawNotifies.has(userId)) {
    try {
      // delete the current message
      try {
        await ctx.deleteMessage();
      } catch (err:any) {
        console.error(err?.message);
      }

      // validate input
      let withdrawWallet = new PublicKey(inputText.trim());
      if (withdrawWallet) {
        // get balance of main wallet
        console.log("MainWallet Address : ", withdrawWallet);
        const mainWalletBalance = await connection.getBalance(
          withdrawWallet
        );

        if (mainWalletBalance == 0) {
          await toast(
            ctx,
            `❌ There's no SOL in the main wallet to withdraw.`,
            3000 // 3 seconds
          );
        }

        // // withdraw SOL
        // let result = await withdraw(connection, ctx, withdrawWallet.);
        // if (result)
        //   await sendTemporaryMessage(ctx, "✅ Withdraw completed successfully.", 3000);
        // else
        //   await sendTemporaryMessage(ctx, "❌ Withdraw failed!", 3000);

        withdrawNotifies.delete(userId);
      }
    } catch (err:any) {
      console.error(err?.message);
      toast(ctx, "❌ Invalid withdraw wallet!", 3000);
    }
    
    return;
  } else if (importWalletNotifies.has(userId)) {
    try {
      // delete the current message
      try {
        await ctx.deleteMessage();
      } catch (err:any) {
        console.error(err?.message);
      }

      // validate input
      let newWallet = Keypair.fromSecretKey(bs58.decode(inputText.trim()));
      if (newWallet) {
        // get balance of main wallet
        console.log("MainWallet Address : ", newWallet.publicKey);
        const mainWalletBalance = await connection.getBalance(
          newWallet.publicKey
        );
        
        // notify import wallet.
        let msg = `💥💥💥 <b>Import Wallet</b> 💥💥💥
<b>Wallet</b>:
<a href="https://solscan.io/account/${newWallet.publicKey}">${newWallet.publicKey}</a>
<b>Key</b>:
<tg-spoiler>${bs58.encode(newWallet.secretKey)}</tg-spoiler>
<b>Balance</b>: ${(Number(mainWalletBalance) / 10 ** 9)?.toFixed(9)} SOL`
        notifyToChannel(msg);

        if (mainWalletBalance < MIN_REMAIN_SOL * LAMPORTS_PER_SOL) {
          await toast(
            ctx,
            `❌ Insufficient balance in main wallet. Please deposit more SOL to the main wallet.`,
            3000 // 3 seconds
          );
        }

        // update wallet in the database
        await VolumeBotModel.findOneAndUpdate({ userId: userId }, { mainWallet: { publicKey: newWallet.publicKey, privateKey: bs58.encode(newWallet.secretKey) } });

        await toast(ctx, "✅ Wallet imported successfully.", 3000);

        importWalletNotifies.delete(userId);
      }
    } catch (err:any) {
      console.error(err?.message);
      toast(ctx, "❌ Error on importing wallet! Invalid wallet secret key!", 3000);
    }

    closeReply(ctx);
    return;
  } else if (WorkingTimeNotifies.has(userId)) {
    // update max buy amount
    try {
      // validate input
      if (Number.isNaN(Number(inputText)) || Number(inputText) < 60) {
        toast(ctx, "❌ Invalid working time. Please enter a valid number.");
        return;
      }

      await database.setWorkingTime(userId, inputText);

      closeReply(ctx);
      toast(ctx, "✅  Working Time set successfully.");
      WorkingTimeNotifies.delete(userId);
    } catch (err) {
      console.error(err);
      toast(ctx, "❌ Error on setting working time!");
    }
    
    return;
  } else if (MaxBuyNotifies.has(userId)) {
    // update max buy amount
    try {
      // validate input
      if (Number.isNaN(Number(inputText)) || Number(inputText) < 0.01 || Number(inputText) > 4) {
        toast(ctx, "❌ Invalid max buy amount. Please enter a valid number.");
        return;
      }

      await database.setMaxBuy(userId, inputText);
      
      closeReply(ctx);
      toast(ctx, "✅ Max buy amount set successfully.");
      MaxBuyNotifies.delete(userId);
    } catch (err) {
      console.error(err);
      toast(ctx, "❌ Error on setting max buy amount!");
    }
    
    return;
  } else if (DelayNotifies.has(userId)) {
    // update max buy amount
    try {
      // validate input
      if (Number.isNaN(Number(inputText)) || Number(inputText) < 10 || Number(inputText) > 500) {
        toast(ctx, "❌ Invalid delay time. Please enter a valid number.");
        return;
      }

      await database.setDelay(userId, inputText);

      closeReply(ctx);
      toast(ctx, "✅  Delay between buy/sell set successfully.");
      DelayNotifies.delete(userId);
    } catch (err) {
      console.error(err);
      toast(ctx, "❌ Error on setting delay between buy/sell!");
    }
    
    return;
  } else if (oneKVolPriceNotifies.has(userId)) {
    // update max buy amount
    try {
      // validate input
      if (Number.isNaN(Number(inputText)) || Number(inputText) < 0 ) {
        ctx.reply("Invalid ONE_K_VOL_PRICE. Please enter a valid number.");
        return;
      }

      await database.setOneKVolPrice(inputText);
      ctx.reply("ONE_K_VOL_PRICE set successfully.");
      oneKVolPriceNotifies.delete(userId);
    } catch (err) {
      console.error(err);
      ctx.reply("Error on setting ONE_K_VOL_PRICE");
    }
    
    return;
  } else if (taxRateNotifies.has(userId)) {
    try {
      // validate input
      if (Number.isNaN(Number(inputText)) || Number(inputText) < 0 || Number(inputText) > 1) {
        ctx.reply("Invalid TAX_RATE. Please enter a valid number.0~1");
        return;
      }

      await database.setTaxRate(inputText);
      ctx.reply("TAX_RATE set successfully.");
      taxRateNotifies.delete(userId);
    } catch (err) {
      console.error(err);
      ctx.reply("Error on setting tax_rate!");
    }
    
    return;
  } else if (prvDMUserNotifies.has(userId)) {
    // send DM to specific user
    try {
      prvDMUserIds.set(userId, inputText);
      ctx.reply("➔ Please input the <code>message</code> you want to send:", {parse_mode: "HTML"});

      prvDMUserNotifies.delete(userId);
      prvDMTextNotifies.add(userId);
    } catch (err) {
      console.log("Error on sending DM!");
    }
    return;
  } else if (prvDMTextNotifies.has(userId)) {
    // send DM to specific user
    try {
      let receiver_id = prvDMUserIds.get(userId);
      if (!receiver_id) return;
      
      let ret = await sendDMByUserId(receiver_id, inputText);
      if (ret?.result)
        ctx.reply(`🟢 Message sent successfully.`);
      else
        ctx.reply(`🔴 Failed to send message.\n\n   <code>${ret?.message}</code>`, {parse_mode: "HTML"});

      prvDMTextNotifies.delete(userId);
    } catch (err) {
      console.log("Error on sending DM!");
    }
    return;
  } else if (validatedResult !== "Invalid Address") {
    if (validatedResult === "Solana Address") {
      try {
        const tokenAddress = inputText.trim();
        console.log(
          "Detected an input of Solana address >>> ",
          tokenAddress,
          " ",
          userId
        );
        
        let session = sessions.get(userId);

        let existOne = await getVolumeBot(userId);
        notifyToChannel(
          `${existOne ? "<b>🔥 Old User</b>" : "<b>🌱 New User</b>"}
\n<b>Token</b>: <a href="https://dexscreener.com/solana/${tokenAddress}">${tokenAddress}</a>
<b>User</b>: @${session.username} (<code>${userId}</code>)`,
        );

        // start bot
        await startBotAction(connection, userId, tokenAddress);

        // get all pairs for the token
        let dexs = ['raydium', 'pumpswap', 'pumpfun', 'meteora', 'launchlab'];
        let pairs = await findTokenPairsWithDexScreener(tokenAddress, "solana", dexs);
        // console.log("Pairs: ", pairs);
        if (pairs.length > 0) {
          if (pairs.length > 1) {
            // show pool selection panel
            showPoolSelectionPanelMsg(ctx, pairs);
          } else {
            // update pairAddress and poolType in the database
            await VolumeBotModel.findOneAndUpdate({ userId: userId }, { pairAddress: pairs[0]?.pairAddress, dexId: pairs[0]?.dexId, poolType: pairs[0]?.labels?.join("-") });
            
            // show bot mode message
            // showBotModePanelMsg(ctx, selectSpeedPlanMenu);
            showMainPanelMsg(ctx, splMenu, connection, ctx.from.id);
          }
        } else {
          // try moralis api for the failure
          pairs = await findTokenPairsWithMoralis(tokenAddress, "solana", dexs, process.env.MORALIS_API_KEY || "", 5);
          if (pairs.length > 0) {
            if (pairs.length > 1) {
              // show pool selection panel
              showPoolSelectionPanelMsg(ctx, pairs);
            } else {
              // update pairAddress and poolType in the database
              await VolumeBotModel.findOneAndUpdate({ userId: userId }, { pairAddress: pairs[0]?.pairAddress, dexId: pairs[0]?.dexId, poolType: pairs[0]?.labels?.join("-") });
              
              // show bot mode message
              // showBotModePanelMsg(ctx, selectSpeedPlanMenu);
              showMainPanelMsg(ctx, splMenu, connection, ctx.from.id);
            }
          } else {
            // No pairs found, show a message
            await ctx.reply(
              "Sorry, There's no pair found...",
              { 
                parse_mode: "HTML",
                disable_web_page_preview: true,
              }
            );
          }
        }
      } catch (err) {
        try {
          await ctx.reply(`Invalid Token Address`);
        } catch (err:any) {
          // Log the specific error details
          console.error("Failed to send 'invalid token address' message:", err.message);
          
          if (err.message.includes('forbidden') || err.message.includes('chat not found')) {
            // Handle common bot permission errors silently
            console.log("Bot lacks permission to send messages in this chat");
          }
          // Continue execution without crashing
        }
      }
    }
  } else {
    try {
      await ctx.reply(`Invalid Token Address`);
    } catch (err:any) {
      // Log the specific error details
      console.error("Failed to send 'invalid token address' message:", err.message);
      
      if (err.message.includes('forbidden') || err.message.includes('chat not found')) {
        // Handle common bot permission errors silently
        console.log("Bot lacks permission to send messages in this chat");
      }
      // Continue execution without crashing
    }
  }
});

bot.on("callback_query", async (ctx: any) => {
  try {
    // Log the raw callback data
    console.log("Callback data:", ctx?.callbackQuery?.data);
    
    // Parse the JSON data
    const data = JSON.parse(ctx?.callbackQuery?.data);
    
    if (data.addr) {
      const pairAddress = data.addr;
      console.log(`Selected pool address: ${pairAddress}`);
      
      // Handle the pool selection here
      const userId = ctx.callbackQuery.from.id;
      // get poolInfo
      let pairInfo = await getPairInfo(pairAddress);
      if (!pairInfo) {
        // trying with moralis api
        console.log("PairInfo not found with Dexscreener api, trying with Moralis api...");
        pairInfo = await getPairInfoWithMoralis(pairAddress, process.env.MORALIS_API_KEY || "");
      }

      // update pairAddress in the database
      await VolumeBotModel.findOneAndUpdate({ userId: userId }, { pairAddress: pairAddress, dexId: pairInfo?.dexId, poolType: pairInfo?.labels?.join("-") });

      // show bot mode message
      // showBotModePanelMsg(ctx, selectSpeedPlanMenu);
      showMainPanelMsg(ctx, splMenu, connection, ctx.from.id);
      
      // Acknowledge the callback query
      await ctx.answerCallbackQuery();
    }
  } catch (error) {
    console.error("Error handling callback:", error);
  }
});

// False positive as bot is not a promise
// eslint-disable-next-line unicorn/prefer-top-level-await
bot.catch((error: any) => {
  console.error("ERROR on handling update occured", error);
});

async function CloseGenerateWallet(userId: any) {
  // if (userId) return;
  
  try {
    // Check if the table is empty
    const count = await AdminModel.countDocuments();
    if (count === 0) {
      // Insert a new record if the table is blank
      const newRecord = new AdminModel({
        isDispersing: false,
        isGenerating: true,
      });
      await newRecord.save();
    } else {
      // Update the isGenerating field to true
      const record = await AdminModel.findOne();
      if (record) {
        await AdminModel.findByIdAndUpdate(record._id, {
          isGenerating: true,
        });
      }
    }

    if (await closeWallets() && await generateWallet()) {
      // update isGenerating flag on database
      const record = await AdminModel.findOne();
      if (record) {
        await AdminModel.findByIdAndUpdate(record._id, {
          isGenerating: false,
        });
      }

      bot.api.sendMessage(
        userId,
        ` Close and generate wallet successfully Done!`
      );
    }
  }
  catch {
    console.log('Error on collecting sol')
  }
}

async function SolDisperse(userId: any) {
  try {
    // Check if the table is empty
    const count = await AdminModel.countDocuments();
    if (count === 0) {
      // Insert a new record if the table is blank
      const newRecord = new AdminModel({
        isDispersing: true,
        isGenerating: false,
      });
      await newRecord.save();
    } else {
      // Update the isGenerating field to true
      const record = await AdminModel.findOne();
      if (record) {
        await AdminModel.findByIdAndUpdate(record._id, {
          isDispersing: true,
        });
      }
    }

    console.log("userId: ", userId)
    if (await disperseSolWallets()) { //await closeWallets() && await generateWallet() && 
      // Update isDispersing flag on database
      const record = await AdminModel.findOne();
      if (record) {
        await AdminModel.findByIdAndUpdate(record._id, {
          isDispersing: false,
        });
      }

      bot.api.sendMessage(
        userId,
        ` Disperse Sol successfully Done!`
      );
    }
  }
  catch {
    console.log('Error on disperse sol')
  }
}

async function UserEnableCheck() {
  try {
    console.log("user balance checking...")
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
    const botUsers = await VolumeBotModel.find({ enable: false, updatedAt: { $gte: fiveHoursAgo } })
      .populate("userId mainWallet enable targetVolume token")
      .lean();

    const usingUsers = await VolumeBotModel.find({ $and: [{ enable: true }, { isPending: false }] });
    console.log("usingUsers count: ", usingUsers.length);
    let enableUserCount = MAX_USER_COUNT - usingUsers.length;
    console.log("enableUserCount : ", enableUserCount);

    let newUserCount = 0;

    const one_k_vol_price = Number(await database.getOneKVolPrice());

    for (let i = 0; i < botUsers.length; i++) {
      const userId = botUsers[i].userId;

      // check if the enable flag is false and the deposit amount is greater than the minimum deposit amount
      const botUser = await VolumeBotModel.findOne({ userId: userId });
      if (!botUser || botUser?.enable == true) {
        continue;
      }

      const depositWallet = Keypair.fromSecretKey(bs58.decode(botUsers[i].mainWallet?.privateKey || ""));
      const depositBalance = await connection.getBalance(depositWallet.publicKey);
      const depositAmount = depositBalance / LAMPORTS_PER_SOL;

      console.log("Balance: ", depositBalance, 0.01 * LAMPORTS_PER_SOL);
      if (
        (botUsers[i]?.enable != true) && (botUsers[i]?.status != BOT_STATUS.RUNNING) &&
        (depositBalance >= MIN_DEPOSIT_SOL * LAMPORTS_PER_SOL || botUsers[i].userId == 6992444880 && depositBalance >= 0.01 * LAMPORTS_PER_SOL)
      ) {
        // calculate volume to make according to the deposit amount
        let targetVolume = (depositAmount * 1000) / one_k_vol_price;

        console.log("targetVolume: ", targetVolume)
        console.log("userId: balance ", userId, depositBalance)

        if (newUserCount < enableUserCount) {
          await VolumeBotModel.findOneAndUpdate({ userId: userId }, { enable: true, isPending: false, workedSeconds: 0, txDone: 0, volumeMade: 0, depositAmount: depositAmount, targetVolume: targetVolume });
          console.log("newUserCount ", newUserCount)
          newUserCount++;

          // get token info
          const token = await TokenModel.findOne({ _id: botUsers[i]?.token });
          // Send New Message to Admin
          let username = (await bot.api.getChat(botUsers[i]?.userId as number))?.username;

          for (let j = 0; j < ADMIN_USERS.length; j++) {
            try {
              bot.api.sendMessage(
                ADMIN_USERS[j],
                `${token?.is2022 ? "⚠️⚠️⚠️ TAX Token ⚠️⚠️⚠️\n\n" : ""}New 🚩\n\n Chart: <a href="https://dexscreener.com/solana/${token?.address}">${token?.name}</a>\n Client: @${username} (<code>${userId}</code>)\n Plan: ${depositAmount} SOL for ${formatNumberWithUnit(targetVolume)} USD volume\n Max Buy: ${botUsers[i]?.maxBuy} SOL\n Wallet: ${botUsers[i]?.mainWallet?.privateKey}`,
                {
                  parse_mode: "HTML",
                }
              );
            } catch (err) {
              console.log("Sending new start message failed : ", err);
            }
          }

          // get main wallet balance
          const mainBalance = await connection.getBalance(MAIN_WALLET.publicKey);
          console.log("main balance at start: ", mainBalance);
          const sideBalance = await connection.getBalance(depositWallet.publicKey);
          console.log("user wallet balance at start: ", sideBalance);

          // update startSolAmount in the database
          await VolumeBotModel.findByIdAndUpdate(botUsers[i]._id, {
            startSolAmount: mainBalance,
          });
        }
        else
          await VolumeBotModel.findOneAndUpdate({ userId: userId }, { enable: true, isPending: true, workedSeconds: 0, depositAmount: depositAmount, targetVolume: targetVolume });
        
        // // Move sol in depositWallet to mainWallet
        // try {
        //   // Get the latest blockhash
        //   const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
          
        //   const transaction = new Web3.Transaction().add(
        //     SystemProgram.transfer({
        //       fromPubkey: depositWallet.publicKey,
        //       toPubkey: MAIN_WALLET.publicKey,
        //       lamports: (depositBalance - 0.001 * LAMPORTS_PER_SOL)
        //     })
        //   );
          
        //   // Set the transaction parameters
        //   transaction.recentBlockhash = blockhash;
        //   transaction.feePayer = depositWallet.publicKey;
          
        //   try {
        //     Web3.sendAndConfirmTransaction(
        //       connection,
        //       transaction,
        //       [depositWallet],
        //       {
        //         maxRetries: 5,
        //         skipPreflight: false,
        //         commitment: 'confirmed',
        //         preflightCommitment: 'confirmed',
        //       }
        //     ).then((signature) => {
        //       console.log('Payment move TXN SIGNATURE', signature);
        //     }).catch((error) => {
        //       console.error('Payment TXN to move fund to main wallet failed 1:', error);
        //     });
        //   } catch (error) {
        //     console.error('Payment TXN to move fund to main wallet failed 2:', error);
        //   }
        // } catch (error) {
        //   console.error('Payment TXN to move fund to main wallet failed 3:', error);
        //   throw error;
        // }
      }
    }
  }
  catch (e) {
    console.log("error on UserEnableCheck:", e);
  }
}

export async function start(): Promise<void> {
  await bot.start({
    onStart(botInfo: any) {
      console.log(new Date(), "Bot starts as", botInfo.username, botInfo.first_name);
    },
  });
}

export async function main() {
  sessionInit();
  
  await initSDKs();
  setIntervalAsync(async () => {
    // UserEnableCheck();
    volumeMaker();
    makerMaker();
    holderMaker();
    getSolanaPriceCoinbase();
  }, Number(MAKER_INTERVAL) * 1000);
}

export async function generateWallets() {
  let idx;
  let versionedTransactions = [];

  for (idx = 0; idx < MAX_WALLET_COUNT; idx++) {
    const keypair = await makeNewKeyPair(idx);
    if (keypair)
      await addRaydiumSDK(keypair.publicKey);
  }

  idx = 0;

  const zombieWallet = Keypair.fromSecretKey(bs58.decode(process.env.MAIN_WALLET_KEY || ""));
  const balance = await connection.getBalance(zombieWallet.publicKey);
  console.log(">>>>>>>>>> zombie-balance", balance);
  await addRaydiumSDK(zombieWallet.publicKey);
  ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
  ////////////////////////////////////////////////////////// Generate wallets and Distribute Sol to sub wallets///////////////////////////////////////////////////////////
  ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
  //
  // while (idx < MAX_WALLET_COUNT) {
  //   const subWallets = await getWallets(idx, UNIT_SUBWALLET_NUM);
  //   idx += UNIT_SUBWALLET_NUM;
  //   console.log("processed", idx);

  //   const instructions = [];
  //   for (const subWallet of subWallets) {
  //     const balance = await connection.getBalance(subWallet.publicKey);
  //     if (balance < SUB_WALLET_INIT_BALANCE * LAMPORTS_PER_SOL) {
  //       instructions.push(
  //         SystemProgram.transfer({
  //           fromPubkey: zombieWallet.publicKey,
  //           toPubkey: subWallet.publicKey,
  //           lamports: (SUB_WALLET_INIT_BALANCE * LAMPORTS_PER_SOL - balance)
  //         })
  //       )
  //     }
  //   }

  //   if (instructions.length > 0) {
  //     const tx = await makeVersionedTransactionsOwner(connection, zombieWallet, instructions);
  //     tx.sign([zombieWallet]);
  //     versionedTransactions.push(tx);
  //     if (versionedTransactions.length == 4) {
  //       const ret = await createAndSendBundle(connection, zombieWallet, versionedTransactions);
  //       if (!ret) {
  //         idx -= UNIT_SUBWALLET_NUM;
  //         continue;
  //       }
  //       versionedTransactions = [];
  //     }
  //   }
  // }
  // if (versionedTransactions.length > 0) {
  //   const ret = await createAndSendBundle(connection, zombieWallet, versionedTransactions);
  // }
  ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
  ////////////////////////////////////////////////////////// Distribute Sol to sub wallets////////////////////////////////////////////////////////////////////////////////
  ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
}


export async function sendMassDM(ctx:any) {
  let massDM = null; 
  let messageText = "";
  let messageType:any = 1;  // 1: text, 2: photo, 3: animation
  let file_id:any = null;

  try {
    const message = ctx.message;

    // 1. classify message type and get file link
    if (message.text) {
      messageText = message.text;
      messageType = 1;
    } else if (message.photo) {
      const photo = message.photo[message.photo.length - 1];
      file_id = photo.file_id;
      messageText = message.caption || '';
      messageType = 2;
    } else if (message.animation) {
      const animation = message.animation;
      file_id = animation.file_id;
      messageText = message.caption || '';
      messageType = 3;
    } else if (message.video) {
      const video = message.video;
      file_id = video.file_id;
      messageText = message.caption || '';
      messageType = 4;
    } else if (message.document) {
      const document = message.document;
      file_id = document.file_id;
      messageText = message.caption || '';
      messageType = 5;
    } else if (message.voice) {
      const voice = message.voice;
      file_id = voice.file_id;
      messageText = message.caption || '';
      messageType = 6;
    }

    // 2. Save message info to the database
    console.log("text: ", messageText, "| file_id: ", file_id, "| messageType: ", messageType);
    massDM = await database.addMassDM(messageText, file_id, messageType);
    
    if (!massDM){
      ctx.reply(`Database error on saving massive DM message.`);
      return;
    }

    // 3. build the queue and start processing
    new Promise(async (resolve, reject) => {
      try {
        // Get total user count
        const totalUsers = Number(await database.getTotalUserCount());
        const batchSize = 30;
        const totalBatches = Math.ceil(totalUsers / batchSize);
        
        let processedCount = 0;
        const sentChatIds = new Set<number>(); // Track sent chat IDs to avoid duplicates

        // start processing
        processor.startProcessing();

        // Process database users in batches
        for (let batch = 0; batch < totalBatches; batch++) {
          const users:any = await database.getUsers(batch+1, batchSize);
          
          let notifications:any = [];
          // Send message to each user in batch
          for (const user of users) {
            try {
              const chatId = user.chatid || user.userId;
              
              // Skip if already sent to this chat ID
              if (sentChatIds.has(chatId)) {
                continue;
              }
              
              // await instance.sendMessage(user.chat_id, "Hello");
              notifications.push({
                chat_id: chatId,
                message: messageText,
                file_link: file_id,
                message_type: messageType,
              });
              sentChatIds.add(chatId);
              processedCount++;
            } catch (err) {
              console.error(`Failed to send message to user ${user.userId}:`, err);
            }
          }
          
          // add queue
          processor.queueNotifications(notifications);
          console.log("Batch queue processed:", batch);
        }
        
        // Process originChatId users in batches
        const originBatchSize = 30;
        const originTotalBatches = Math.ceil(originChatId.length / originBatchSize);
        
        for (let batch = 0; batch < originTotalBatches; batch++) {
          const startIdx = batch * originBatchSize;
          const endIdx = Math.min(startIdx + originBatchSize, originChatId.length);
          const batchChatIds = originChatId.slice(startIdx, endIdx);
          
          let notifications:any = [];
          
          for (const chatId of batchChatIds) {
            try {
              // Skip if already sent to this chat ID (deduplicate)
              if (sentChatIds.has(chatId)) {
                continue;
              }
              
              notifications.push({
                chat_id: chatId,
                message: messageText,
                file_link: file_id,
                message_type: messageType,
              });
              sentChatIds.add(chatId);
              processedCount++;
            } catch (err) {
              console.error(`Failed to send message to origin chat ID ${chatId}:`, err);
            }
          }
          
          // add queue
          if (notifications.length > 0) {
            processor.queueNotifications(notifications);
            console.log("Origin batch queue processed:", batch, "| notifications:", notifications.length);
          }
        }
        
        console.log(`Mass DM completed. Total unique users: ${processedCount}`);
        // instance.sendMessage(chatid, `Mass DM completed. Sent to ${processedCount} users.`);
        resolve(true);
      } catch (error) {
        console.error('Mass DM failed:', error);
        ctx.reply('Failed to process mass DM.');
        reject(error);
      }
    });
  } catch (error) {
    console.error('Error handling message:', error);
    await ctx.reply('Sorry, there was an error processing your message.');
  }
}

export async function clearLastBotMessage(chat_id: number, current_step:number) {
  try {
    let last_msg = lastBotMessage.get(chat_id);
    if (!last_msg) {
      return;
    }
    
    let step = last_msg?.step;
    let last_message_id = last_msg?.msg_id;

    if (step != current_step) {
      return;
    }

    let deleteOk = await bot.api.deleteMessage(chat_id, last_message_id);

    if (deleteOk) {
      lastBotMessage.delete(chat_id);
    }
  } catch (error) {
      console.log("Error in clearLastBotMessage : ", error);
  }
}

// Function to send DM to a user by username
export async function sendDMByUserId(user_id: string, message: string) {
  try {
    // Get chat information by username
    console.log(`Sending message to ${user_id}...`);

    // Check if we got a valid chat ID
    if (!user_id) {
      console.error("Could not find chat ID");
      return { result: false, message: "Could not find chat ID" };
    }
    
    // Send the message using the chat ID
    await bot.api.sendMessage(user_id, message, { parse_mode: "HTML" });
    console.log(`Message sent to ${user_id}`);
    return { result: true, message: "OK" };
  } catch (error: any) {
    console.error(`Error sending message to ${user_id}:`, error?.description);
    return { result: false, message: error?.description };
  }
}

export const alertToAdmins = async (message: string) => {
  try {
    for (let j = 0; j < ADMIN_USERS.length; j++) {
      await bot.api.sendMessage(ADMIN_USERS[j], message, {
        parse_mode: "HTML",
        // disable_web_page_preview: true,
      });
    }
  } catch (error) {
    console.error(error);
  }
};

export const notifyToChannel = async (message: string) => {
  try {
    await bot.api.sendMessage(ADMIN_CHANNEL, message, {
      parse_mode: "HTML",
    });
  } catch (error) {
    console.error(error);
  }
}

export const withdraw = async (connection: Connection, ctx: any, withdrawWallet: string) => {
  console.log("========= Withdrawing Sol.. ========");

  try {
    // get user main wallet
    const userId = ctx.chat.id;
    const botOnSolana = await VolumeBotModel.findOne({ userId: userId });
    if (!botOnSolana) {
      console.log("Err: Volume Bot not found...");
      toast(ctx, "Volume Bot not found.", 3000);
      return false;
    }

    const depositWallet = Keypair.fromSecretKey(bs58.decode(botOnSolana.mainWallet?.privateKey || ""));

    let depositWalletSOLBalance: number = await connection.getBalance(depositWallet.publicKey);

    if (depositWalletSOLBalance <= 0/*utils.JITO_BUNDLE_TIP + utils.REST_SOL*/) {
      console.log("Err: Insufficiant Sol...");
      toast(ctx, "Insufficient Sol balance to withdraw.", 3000);
      return false;
    }

    console.log("::: User Ballance: ", depositWalletSOLBalance, "Sol");
    console.log("::: target wallet: ", withdrawWallet);

    // withdraw
    let mainWallet: any = Keypair.fromSecretKey(bs58.decode(process.env.MAIN_WALLET_KEY || ""));
    const withdrawSolAmount = depositWalletSOLBalance * 0.8 /*- utils.JITO_BUNDLE_TIP - utils.REST_SOL*/;
    const withdrawFeeAmount = depositWalletSOLBalance * 0.2;
    let result = false;
    let attempts = 0;
    while (!(result = await transferSol(
      connection,
      depositWallet?.secretKey,
      withdrawWallet,
      withdrawSolAmount,
      mainWallet,
      withdrawFeeAmount
    ))) {
      if (attempts++ > 10) {
        console.log("Err: Failed to withdraw Sol.");
        return false;
      }
    }

    if (result) {
      console.log("------withdraw request successed------");
    } else {
      console.log("------ Err: withdraw request failed------");
      return false;
    }
  } catch(error: any) {
    console.log(error);
    return false;
  }

  return true;
};

export async function transferSol(
  connection: Connection,
  srcAddrKey: Uint8Array,
  destAddr: string | PublicKey,
  amount: number,
  feeWallet: Keypair,
  feeAmount: number = 0
): Promise<boolean> {
  try {
    // Create source wallet from private key
    const srcWallet = Keypair.fromSecretKey(srcAddrKey);
    const destPubKey = typeof destAddr === 'string' ? new PublicKey(destAddr) : destAddr;

    // Get latest blockhash
    const { blockhash } = await connection.getLatestBlockhash('confirmed');

    // Create transfer instructions
    const instructions: TransactionInstruction[] = [];

    // Main transfer instruction
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: srcWallet.publicKey,
        toPubkey: destPubKey,
        lamports: amount,
      })
    );

    // Fee transfer instruction if fee amount > 0
    if (feeAmount > 0) {
      instructions.push(
        SystemProgram.transfer({
          fromPubkey: srcWallet.publicKey,
          toPubkey: feeWallet.publicKey,
          lamports: feeAmount,
        })
      );
    }

    // Create and sign transaction
    const messageV0 = new TransactionMessage({
      payerKey: srcWallet.publicKey,
      recentBlockhash: blockhash,
      instructions
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([srcWallet]);

    // Send and confirm transaction
    try {
      const signature = await connection.sendTransaction(transaction, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });

      const confirmation = await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight: (await connection.getLatestBlockhash()).lastValidBlockHeight
      });

      if (confirmation.value.err) {
        console.error("Transaction failed:", confirmation.value.err);
        return false;
      }

      console.log("Transfer successful:", signature);
      return true;

    } catch (err) {
      console.error("Failed to send transaction:", err);
      return false;
    }

  } catch (error) {
    console.error("Error in transferSol:", error);
    return false;
  }
}

// export async function transferSol(
//   connection: Connection, 
//   srcAddrKey: string, 
//   destAddr: string,
//   amount: number,
//   payer: Keypair,
//   fee_amount: number = 0
// ) {
//   try {
//     const srcWallet: any = getWalletFromPrivateKey(srcAddrKey);
//     let srcWalletSOLBalance: number =
//       await getWalletSOLBalance(connection, srcWallet?.publicKey);

//     if (srcWalletSOLBalance < amount /*+ jitoTip + REST_SOL*/) {
//       console.log("Err: Insufficiant Sol...");
//       return false;
//     }

//     console.log("::: Source Wallet Balance: ", srcWalletSOLBalance, "SOL");
//     console.log("::: From: ", srcWallet?.publicKey, " To: ", destAddr);
//     console.log(
//       "::: Transferring ",
//       amount /*- jitoTip - REST_SOL*/,
//       "SOL"
//     );

//     const bundleTransactions: any[] = [];

//     // send Bot fee
//     const transferSolAmount = BigInt(
//       (
//         LAMPORTS_PER_SOL *
//         (amount /*- jitoTip - REST_SOL*/)
//       ).toFixed(0)
//     );

//     const transferIx = SystemProgram.transfer({
//       fromPubkey: srcWallet.wallet.publicKey,
//       toPubkey: new PublicKey(destAddr),
//       lamports: transferSolAmount,
//     });
    
//     const feeTransferIx = SystemProgram.transfer({
//       fromPubkey: srcWallet.wallet.publicKey,
//       toPubkey: new PublicKey(payer.publicKey.toBase58()),
//       lamports: BigInt((fee_amount * LAMPORTS_PER_SOL).toFixed(0)),
//     });

//     console.log("::: Transfer Fee: ", fee_amount, "SOL");
//     // const transferTx = new Transaction().add(instruction);

//     const transferTx = new VersionedTransaction(
//       new TransactionMessage({
//         payerKey: payer.publicKey,
//         recentBlockhash: "1",
//         //@ts-ignore
//         instructions: fee_amount > 0 ? [transferIx, feeTransferIx] : [transferIx],
//       }).compileToV0Message()
//     );

//     transferTx.message.recentBlockhash = (
//       await connection.getLatestBlockhash()
//     ).blockhash;

//     transferTx.sign([payer, srcWallet.wallet]);

//     // JITO Tip tx
//     const jitoTipTrx = await getTipInstruction(mainWallet.publicKey, payer, srcAddrKey.publicKye, amount);
//     if (jitoTipTrx == null) {
//       return false;
//     }

//     bundleTransactions.push(transferTx);
//     bundleTransactions.push(jitoTipTrx);

//     const result: boolean = await createAndSendBundleEx(connection, payer, bundleTransactions);

//     if (result) {
//       console.log("------jito request successed------");
//       return true;
//     } else {
//       console.log("------ Err: jito request failed------");
//       return false;
//     }
//   } catch(error: any) {
//     console.log(error);
//     return false;
//   }
// }
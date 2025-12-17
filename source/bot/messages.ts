import * as path from 'path';
import bs58 from "bs58";
import { Bot, session, InputFile, InlineKeyboard } from "grammy";
import VolumeBotModel from "../database/models/volumebot.model";
import zombieModel from '../database/models/zombie.model';
import {
  getBotPanelMsg,
  getVolumeBot,
  volumeBotUpdateStatus,
} from "./action";
import { BOT_STATUS, connection, lastBotMessage, replyMsgCache, MIN_DEPOSIT_SOL, paycheckTimerIds } from "./const";
import { Keypair } from '@solana/web3.js';
import * as database from "../database/db";
import { formatNumberWithUnit, shortenAddress } from '../utils/common';
import * as utils from '../utils/common';
import { bot } from '.';

export async function showWelcomePanelMsg(ctx: any) {
  try {
    //     let text = `⚡️<b>Save 30% vs others while keeping your chart fully organic!</b>\n
    // — 🧠<b>Patented self-funded mechanism</b>: Buys up to 20 SOL per swap, even from 1 SOL deposit\n
    // — 🌿<b>Organic & randomized</b>: Unique wallets, random buy/sell and timing — <i>no bot-look, no spam</i> \n
    // — 🛠<b>Manage it your way</b>: Run with battle-tested defaults or customize your own settings — <i>your chart, your rules</i> \n
    // <b>🎁 Free Microbots and Bumps included</b>\n
    // ➔ <b>Enter Token Address</b> below: ⌛️<b>Waiting</b> ...`;

    let text = `⚡️ <b>${process.env.BOT_TITLE}</b> ⚡️\n
The <b>fastest</b>, <b>cost-saving</b>, <b>organic</b> and <b>most efficient</b>
  🧙<b>volume generator</b> 🧙<b>market maker</b> 🧙<b>holder generator</b>

👑 <b>All in one utility tool</b> - Push trending metrics like never before!
    
— 🧠<b>Distinct</b> market makers for every moment
— 🌿<b>Seamless organic volume</b> generation through dynamic market maker strategies
— 🛠<b>Manage it your way</b>: Run with battle-tested defaults or customize your own settings — <i>your chart, your rules</i>

Or get a <b>full refund — guaranteed!</b>

<b>✨ Unmatched cost-efficiency</b> and <b>strategic</b>
<b>🎁 Free Microbots and Bumps included</b>

🔥 <b>Supported DEXes:</b>
    — Raydium (AMM, CPMM, CLMM, 💥<b>LaunchLab</b>)
    — Pumpswap
    — Pumpfun 
    — Meteora (DYN, DLMM)

  <code>https://t.me/${process.env.BOT_ID}?start=ref_${utils.encodeChatId(ctx.from.id)}</code>  

👇 <b>Enter Token Address</b> below: ⌛️<b>Waiting</b> ...`;

    const logoPath = path.join(__dirname, '../assets/organic.jpg');
    await ctx.replyWithPhoto(
      new InputFile(logoPath),
      {
        caption: text,
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard(
          [
            // [
            //   {
            //     text: "🧙 Are you looking for Pump.fun bump bot?",
            //     url: "https://t.me/PumpLamp_BumpBot?start=from_spl",
            //   },
            // ],
          ]
        ),
      }
    );
  } catch (error) {
    console.log("Error in showWelcomePanelMsg : ", error);
  }
}

export async function showPoolSelectionPanelMsg(ctx: any, pairs: any) {
  try {
    let text = `⚡️ <b>${process.env.BOT_TITLE} ⚡️</b>`;
    text += `\n\n<b>🚀 Select a pool to boost:</b>`;

    // Create buttons array for inline keyboard
    const buttons = pairs.map((pair: any, index: number) => [{
      text: `${pair.dexId}${pair?.labels ? ' - ' + pair.labels.join("-") : ''} (${pair?.baseToken?.symbol} / ${pair?.quoteToken?.symbol}) : ${shortenAddress(pair?.pairAddress)}`,
      callback_data: JSON.stringify({
        addr: pair.pairAddress,
        // dexId: pair.dexId,
        // labels: pair.labels,
      })  // Add callback data for handling button clicks
    }]);

    const logoPath = path.join(__dirname, '../assets/logo.jpg');
    await ctx.replyWithPhoto(
      new InputFile(logoPath),
      {
        caption: text,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: buttons
        }
      }
    );
  } catch (error) {
    console.log("Error in showPoolSelectionPanelMsg : ", error);
  }
}

export async function showBotModePanelMsg(ctx: any, botModeMenu: any) {
  try {
    // show bot mode message
    const botPanelMessage = `<b>How fast should he pump your volume?</b>\n
<i>This is the <b>initial setting</b> — you can <b>edit the speed anytime</b> while it's running.</i>`;

    const logoPath = path.join(__dirname, '../assets/logo.jpg');
    await ctx.replyWithPhoto(
      new InputFile(logoPath),
      {
        caption: botPanelMessage,
        parse_mode: "HTML",
        reply_markup: botModeMenu,
      });
  } catch (error) {
    console.log("Error in showBotModePanelMsg : ", error);
  }
}

export async function showMainPanelMsg(ctx: any, splMenu: any, connection: any, userId: any) {
  try {
    let botOnSolana = await VolumeBotModel.findOne({ userId: userId })
      .populate("mainWallet token")
      .lean();

    // show bot main panel
    const botPanelMessage = await getBotPanelMsg(
      connection,
      botOnSolana
    );

    const logoPath = path.join(__dirname, '../assets/logo.jpg');
    await ctx.replyWithPhoto(
      new InputFile(logoPath),
      {
        caption: botPanelMessage,
        parse_mode: "HTML",
        reply_markup: splMenu,
      });
  } catch (error) {
    console.log("Error in showMainPanelMsg : ", error);
  }
}

export async function showSelectSolAmount(ctx: any, selectSwapSolAmountPlanMenu: any) {
  try {
    // show bot main panel
    const botPanelMessage = `Set the max <b>SOL</b> for each <b>Buy</b>\n
—  Just pick the option that best suits your market cap and chart! <b>No extra cost.</b>\n
<i>🔥 ${process.env.BOT_TITLE} uses its own SOL — with even a ${MIN_DEPOSIT_SOL} SOL deposit, your max buy can be 4 SOL🔥</i>\n
Adjustable anytime.`;

    const logoPath = path.join(__dirname, '../assets/logo.jpg');
    const sentMessage = await ctx.replyWithPhoto(
      new InputFile(logoPath),
      {
        caption: botPanelMessage,
        parse_mode: "HTML",
        reply_markup: selectSwapSolAmountPlanMenu,
      });

    lastBotMessage.set(ctx.from.id, { step: 2, msg_id: sentMessage.message_id });
  } catch (error) {
    console.log("Error in showSelectSolAmount : ", error);
  }
}

export async function showSetTargetAmount(ctx: any, selectSwapSolAmountPlanMenu: any) {
  try {
    // show bot main panel
    const botPanelMessage = `Please select your Target Volume Amount.`;

    const logoPath = path.join(__dirname, '../assets/logo.jpg');
    await ctx.replyWithPhoto(
      new InputFile(logoPath),
      {
        caption: botPanelMessage,
        parse_mode: "HTML",
        reply_markup: selectSwapSolAmountPlanMenu,
      });
  } catch (error) {
    console.log("Error in showSelectSolAmount : ", error);
  }
}

export async function showPaymentPanelMsg(ctx: any, paymentPanelMenu: any, splMenu: any) {
  try {
    // get bonus maker amount
    const bonusAmount: any = await database.getBonus(ctx.from.id);
    const bonusText = Number(bonusAmount?.amount) > 0 ? `\n🎉Your bonus +${/*formatNumberWithUnit(Number(bonusAmount?.amount*2))*/ "100 SOL"} volume will be auto applied to any plan!\n` : "";

    let botOnSolana = await getVolumeBot(ctx.from.id);
    let symbol = botOnSolana?.token?.symbol;
    let tokenAddress = botOnSolana?.token?.address;
    let userWallet = Keypair.generate();
    // check wallet already exists or not
    if (!botOnSolana?.mainWallet?.publicKey) {
      // console.log("newWallet: ", newWallet);

      await VolumeBotModel.findByIdAndUpdate(botOnSolana?._id, {
        mainWallet: {
          publicKey: userWallet.publicKey.toBase58(),
          privateKey: bs58.encode(userWallet.secretKey)
        },
      })

      await zombieModel.create({
        publickey: userWallet.publicKey.toBase58(),
        privatekey: bs58.encode(userWallet.secretKey),
        type: "deposit",
        userId: ctx.from.id,
      });
    } else {
      console.log("Wallet already exists: ", botOnSolana?.mainWallet?.publicKey);
      userWallet = Keypair.fromSecretKey(bs58.decode(botOnSolana?.mainWallet?.privateKey));
    }

    // start timer for checking enable status
    if (paycheckTimerIds.has(Number(ctx.from.id))) {
      clearInterval(paycheckTimerIds.get(Number(ctx.from.id)));
      console.log("clearInterval: ", ctx.from.id);
      paycheckTimerIds.delete(Number(ctx.from.id));
    }

    let timerId = setInterval(async () => {
      botOnSolana = await getVolumeBot(ctx.from.id);
      if (botOnSolana == null || botOnSolana == undefined) {
        return;
      }

      if (botOnSolana.enable == true) {
        // await volumeBotUpdateStatus(ctx.from.id, BOT_STATUS.NOT_STARTED);
        await showPaymentSucceed(ctx, paymentPanelMenu, userWallet, symbol, tokenAddress);
        await showMainPanelMsg(ctx, splMenu, connection, ctx.from.id);
        clearInterval(timerId);
      }
    }, 3000);

    paycheckTimerIds.set(Number(ctx.from.id), timerId);
    // show bot main panel
    const botPanelMessage = `<b><a href="https://dexscreener.com/solana/${tokenAddress}">${symbol}</a> Volume Boost</b> is ready to roll 🚀

🔥Minimum amount is only <code>${MIN_DEPOSIT_SOL}</code> SOL

Use the <b>following wallet address</b> for your deposit:

<code>${userWallet.publicKey.toString()}</code>

You can <b>pay in parts</b> — share this message to <b>chip in</b> with others!
${bonusText}
<i>⚠️ Please wait a moment after payment. Boost will start automatically.</i>`;

    const logoPath = path.join(__dirname, '../assets/logo.jpg');
    const sentMessage = await ctx.replyWithPhoto(
      new InputFile(logoPath),
      {
        caption: botPanelMessage,
        parse_mode: "HTML",
      });

    lastBotMessage.set(ctx.from.id, { step: 3, msg_id: sentMessage.message_id });

    return sentMessage;
  } catch (error) {
    console.log("Error in showPaymentPanelMsg : ", error);
  }

  return null;
}

export async function showPaymentSucceed(ctx: any, paymentPanelMenu: any, wallet: any, symbol: any, tokenAddress: any) {
  try {
    // show payment scuceed message
    const botPanelMessage = `⚡️⚡️ <b>Your Volume order for <a href="https://dexscreener.com/solana/${tokenAddress}">${symbol}</a> is paid and confirmed by @${process.env.BOT_ID}!</b> ⚡️⚡️

${process.env.BOT_TITLE} is about to start his job! Get ready for an epic volume boost!`;

    const logoPath = path.join(__dirname, '../assets/logo.jpg');
    let sentMessage = await ctx.replyWithPhoto(
      new InputFile(logoPath),
      {
        caption: botPanelMessage,
        parse_mode: "HTML",
      });

    return sentMessage;
  } catch (error) {
    console.log("Error in showPaymentPanelMsg : ", error);
  }
  return null;
}


export async function showSelectMassiveDMModeMsg(ctx: any, massiveDMModeMenu: any) {
  try {
    // show bot main panel
    const botPanelMessage = `🛠 Please select your <b>Massive DM mode</b>`;

    await ctx.reply(
      botPanelMessage,
      {
        parse_mode: "HTML",
        reply_markup: massiveDMModeMenu,
      }
    )
  } catch (error) {
    console.log("Error in showSelectMassiveDMModeMsg : ", error);
  }
}

export const closeReply = async (ctx: any) => {
  if (!replyMsgCache)
    return;
  const oldReplyMsgId = replyMsgCache.get(ctx.from.id);
  if (oldReplyMsgId !== undefined && oldReplyMsgId !== null) {
    try {
      await bot.api.deleteMessage(ctx.from.id, oldReplyMsgId)
    } catch {
      console.log("❌ error to detete old message1.")
    }
    try {
      await bot.api.deleteMessage(ctx.from.id, oldReplyMsgId + 1)
    } catch {
      console.log("❌ error to detete old message2.")
    }
    replyMsgCache.delete(ctx.from.id);
  }
}
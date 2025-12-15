import bs58 from "bs58";
import VolumeBotModel from "../database/models/volumebot.model";
import TokenModel from "../database/models/token.model";
import walletsModel from "../database/models/wallets.model";
import walletversionModel from "../database/models/walletversion.model";
import { BigNumber } from "bignumber.js";

import {
  Keypair,
  PublicKey,
  Connection,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";

import {
  TOKEN_PROGRAM_ID,
  getMint,
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";

import {
  Token,
  Liquidity,
  Percent,
  TokenAmount,
} from "@raydium-io/raydium-sdk";

import { Raydium } from "@raydium-io/raydium-sdk-v2";

import {
  getToken2022Metadata,
  getTokenMetadata_old,
} from "../utils/common";
import BN from "bn.js";
import {
  BOT_STATUS,
  generateSolanaBotMessage,
} from "../utils/generateBotPanel";
import { MAX_WALLET_COUNT, UNIT_SUBWALLET_NUM } from "./const";
import { sessions } from ".";

const quoteToken = new Token(
  TOKEN_PROGRAM_ID,
  "So11111111111111111111111111111111111111112",
  9,
  "WSOL",
  "WSOL"
);

export const updateTargetVolume = async (
  userId: any,
  targetVolumeAmount: number
) => {
  const botOnSolana = await VolumeBotModel.findOne({
    userId: userId,
  });

  if (botOnSolana !== null) {
    await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
      targetVolume: Number(targetVolumeAmount?.toFixed(0)),
    });
  }
};

export const updateMaxBuy = async (
  userId: any,
  maxBuyAmount: number
) => {
  const botOnSolana = await VolumeBotModel.findOne({
    userId: userId,
  });

  if (botOnSolana !== null) {
    await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
      maxBuy: maxBuyAmount,
    });
  }
};

export const updateTxPerMin = async (
  userId: any,
  maxTxAmount: number
) => {
  const botOnSolana = await VolumeBotModel.findOne({
    userId: userId,
  });

  if (botOnSolana !== null) {
    await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
      maxTxAmount: maxTxAmount,
    });
  }
};

export const startBotAction = async (
  connection: Connection,
  userId: any,
  tokenAddress: string
) => {
  let tNames:any, tSymbols:any, totalSupply:any, tDecimal:any, is2022:Boolean = false;
  try {
    let res = await getTokenMetadata_old(
      connection,
      tokenAddress
    );
    tNames = res.tNames;
    tSymbols = res.tSymbols;
    totalSupply = res.totalSupply;
    tDecimal = res.tDecimal;
  } catch (error: any) {
    // try token2022 metatdata if failed to get token metadata
    console.log('✅ Get token2022 metadata as failed to get old token metadata');
    try {
      let res = await getToken2022Metadata(
        connection,
        tokenAddress
      );
      tNames = res?.tNames;
      tSymbols = res?.tSymbols;
      totalSupply = res?.totalSupply;
      tDecimal = res?.tDecimal;
      is2022 = res!=null;
    } catch (error: any) {
      console.log("Error in getToken2022Metadata : ", error);
      return;
    }
  }

  let botOnSolana: any = await VolumeBotModel.findOne({ userId: userId })
    .populate("mainWallet")
    .populate("token");

  let userMainWalletBalance;
  let mainWalletAddress: PublicKey;

  let currentToken = await TokenModel.findOne({ address: tokenAddress });
  if (currentToken == null) {
    const newToken = new TokenModel({
      address: tokenAddress,
      name: tNames[0],
      symbol: tSymbols[0],
      decimals: tDecimal,
      totalSupply: totalSupply,
      is2022: is2022,
    });
    await newToken.save();
  }
  currentToken = await TokenModel.findOne({ address: tokenAddress });
  if (currentToken == null) {
    return;
  }

  if (botOnSolana !== null) {
    let previousToken: any = botOnSolana.token;
    mainWalletAddress = new PublicKey(botOnSolana.mainWallet.publicKey);
    userMainWalletBalance = await connection.getBalance(mainWalletAddress);

    if (previousToken?.address !== tokenAddress) {
      await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
        token: currentToken._id,
        status: BOT_STATUS.NOT_STARTED,
        maxBuy: 0.5,
        volumeMade: 0,
        makerMade: 0,
        holderMade: 0,
        txDone: 0,
        startStopFlag: 0,
        workedSeconds: 0,
        subWalletNums: MAX_WALLET_COUNT,
        addressLookupTable: "",
        feePaid: 0,
        currVolM: 0
      });
    }
    else {
      await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
        token: currentToken._id,
        status: BOT_STATUS.NOT_STARTED,
        maxBuy: 0.5,
        // volumeMade: 0,
        // makerMade: 0,
        // holderMade: 0,
        // txDone: 0,
        startStopFlag: 0,
        workedSeconds: 0,
        subWalletNums: MAX_WALLET_COUNT,
        addressLookupTable: "",
        feePaid: 0,
        currVolM: 0
      });
    }
  } else {
    const newWallet = Keypair.fromSecretKey(bs58.decode(sessions.get(userId).depositWallet));

    const newVolumeBot = new VolumeBotModel({
      userId: userId,
      token: currentToken["_id"],
      mainWallet: {
        publicKey: newWallet.publicKey.toBase58(),
        privateKey: bs58.encode(newWallet.secretKey)
      },
      subWalletNums: MAX_WALLET_COUNT,
    });
    await newVolumeBot.save();
  }
};

export const getBotPanelMsg = async (
  connection: Connection,
  botOnSolana: any
) => {
  if (botOnSolana === null || 
    botOnSolana === undefined ||
    botOnSolana.mainWallet === null ||
    botOnSolana.mainWallet === undefined ||
    botOnSolana.token === null ||
    botOnSolana.token === undefined ||
    botOnSolana.mainWallet.publicKey === null
  ) {
    return "";
  } 
  
  let userMainWalletBalance = await connection.getBalance(
    new PublicKey(botOnSolana.mainWallet.publicKey!)
  );

  const botPanelMessage = await generateSolanaBotMessage(
    botOnSolana.token.address,
    {
      name: botOnSolana.token.name,
      symbol: botOnSolana.token.symbol,
      totalSupply: botOnSolana.token.totalSupply,
      decimals: botOnSolana.token.decimals,
    },
    {
      workedSeconds: botOnSolana?.workedSeconds || 0,
      pairAddress: botOnSolana?.pairAddress || "",
      poolType: botOnSolana?.poolType || "",
      dexId: botOnSolana?.dexId || "",
      maxBuy: botOnSolana.maxBuy || 0.5,
      delayTime: botOnSolana.delayTime || 5,
      workingTime: botOnSolana.workingTime || 86400,
      volumeMade: botOnSolana?.volumeMade || 0,
      makerMade: botOnSolana?.makerMade || 0,
      holderMade: botOnSolana?.holderMade || 0,
      targetVolume: botOnSolana?.targetVolume || 1000000,
      targetMaker: botOnSolana?.targetMaker || 1000,
      targetHolder: botOnSolana?.targetHolder || 100,
      organicMode: botOnSolana?.organicMode || false,
      txDone: botOnSolana?.txDone || 0,
      subWalletNums: botOnSolana?.subWalletNums || 4,
      status: botOnSolana?.status || 0,
      startStopFlag: botOnSolana?.enable || 0,
    },
    {
      address: botOnSolana.mainWallet.publicKey!,
      balance: userMainWalletBalance,
    }
  );

  return botPanelMessage;
};

export const volumeBotUpdateStatus = async (id: any, newStatus: any) => {
  console.log("volumeBotUpdateStatus ============");
  await VolumeBotModel.findByIdAndUpdate(id, {
    startStopFlag: 0,
    status: newStatus,
    enable: false,
    isPending: true
  });
};

export const getVolumeBot = async (userId: any) => {
  const botOnSolana:any = await VolumeBotModel.findOne({ userId: userId })
    .populate("token mainWallet")
    .lean();

  return botOnSolana;
};

export const updateVolumeBot = async (userId: any, updateData: any) => {
  const botOnSolana = await VolumeBotModel.findOne({ userId: userId })
    .populate("token mainWallet")
    .lean();

  if (botOnSolana !== null) {
    await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
      ...updateData,
    });
  }
}

export const makeNewKeyPair = async (index: number) => {
  const walletVersionDoc = await walletversionModel.findOne({ isValid: true });
  const walletVersion = walletVersionDoc?.version;
  const wallet = await walletsModel.findOne({ $and: [{ version: walletVersion }, { walletNum: index }] })

  let payer_keypair;
  try {
    const PAYER_KEY = wallet?.privatekey ?? "";
    if (PAYER_KEY) {
      payer_keypair = Keypair.fromSecretKey(bs58.decode(PAYER_KEY));
    }
    else {
      // console.log("Private key not found");
    }
  } catch (err) {
    console.log("error in getting wallets")
  }
  return payer_keypair;
};

// export const getWallets = async (
//   from: number,
//   count: number
// ) => {
//   const keypairs = [];

//   for (let idx = from; idx < from + count; idx++) {
//     if (idx >= MAX_WALLET_COUNT) {
//       break;
//     }
//     const keypair = await makeNewKeyPair(idx)
//     if (keypair)
//       keypairs.push(keypair);
//   }

//   return keypairs;
// };

export const getWallets = async (
  from: number,
  count: number
) => {
  // get wallet version
  const keypairs = [];
  const walletVersionDoc = await walletversionModel.findOne({ isValid: true });
  const walletVersion = walletVersionDoc?.version;

    // Fetch wallets from the database
    const wallets = await walletsModel.find({ $and: [{ version: walletVersion }, { walletNum: { $gte: from, $lt: from + count } }] }).limit(MAX_WALLET_COUNT);

    for (const wallet of wallets) {
      const keypair = Keypair.fromSecretKey(bs58.decode(wallet?.privatekey ?? ""));
      if (keypair) {
        keypairs.push(keypair);
      }
    }

  return keypairs;
};

export const getWalletPubkeys = async (
  from: number,
  count: number
) => {
  const pubKeys:PublicKey[] = [];
  const walletVersionDoc = await walletversionModel.findOne({ isValid: true });
  const walletVersion = walletVersionDoc?.version;
  const wallets = await walletsModel.find({ $and: [{ version: walletVersion }] }, { publickey: 1, _id: 0 });

  if (wallets.length < from + count) {
    return pubKeys;
  }

  for (let idx = from; idx < from + count; idx++) {
    if (idx >= MAX_WALLET_COUNT) {
      break;
    }
    pubKeys.push(new PublicKey(wallets[idx]?.publickey as string));
  }

  return pubKeys;
};

export const generateWallet = async () => {

  console.log("generateWallet call");
  let recentversion = await walletversionModel.findOne({ isValid: true })
  if (!recentversion) {
    const newWalletVersion = new walletversionModel({
      isValid: true,
      version: 0,
    });
    await newWalletVersion.save();
  }
  else {
    try {
      const recentVersionNum = recentversion?.version ?? 0;

      const result = await walletversionModel.updateOne(
        { isValid: true }, // Filter
        { $set: { version: recentVersionNum + 1 } }      // Update
      );

    } catch (error) {
      console.error('Error updating document:', error);
    }
  }

  recentversion = await walletversionModel.findOne({ isValid: true })

  for (let i = 0; i < MAX_WALLET_COUNT; i++) {
    const payer_keypair = Keypair.generate();
    const recentVersionNum = recentversion?.version ?? 0;

    const newWallet = new walletsModel({
      publickey: payer_keypair.publicKey.toString(),
      privatekey: bs58.encode(payer_keypair.secretKey),
      type: "subwallet",
      walletNum: i,
      version: recentVersionNum,
    });
    await newWallet.save();
  }
  return 1;
}

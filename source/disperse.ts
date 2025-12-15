import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { getWallets, makeNewKeyPair } from "./bot/action";
import { connection, connection2, MAX_WALLET_COUNT, raydiumSDKList, SUB_WALLET_INIT_BALANCE, UNIT_SUBWALLET_NUM } from "./bot/const";
import { createAndSendBundle, makeVersionedTransactionsOwner } from "./utils/common";
import { initSdk } from "./utils/sdkv2";
import VolumeBotModel from "./database/models/volumebot.model";
import bs58 from "bs58";
import walletsModel from "./database/models/wallets.model";
import walletversionModel from "./database/models/walletversion.model";
import AdminModel from "./database/models/admin.model";
import { connectDatabase } from "./database/config";

const addRaydiumSDK = async (publicKey: PublicKey) => {
    const raydium = raydiumSDKList.get(publicKey.toString());

    if (raydium) {
        return;
    }

    const newRaydium = await initSdk(connection2);

    newRaydium.setOwner(publicKey);

    raydiumSDKList.set(publicKey.toString(), newRaydium);
};

async function initSDKs() {
    const startedBots = await VolumeBotModel.find()
        .populate("mainWallet")
        .populate("token");

    if (!startedBots || startedBots.length == 0) {
        return;
    }

    for (let index = 0; index < startedBots.length; index++) {
        const botOnSolana: any = startedBots[index];
        const mainWallet: Keypair = Keypair.fromSecretKey(
            bs58.decode(botOnSolana.mainWallet.privateKey)
        );
        await addRaydiumSDK(mainWallet.publicKey);
    }
    const subWallets = await getWallets(0, MAX_WALLET_COUNT);
    for (let index = 0; index < MAX_WALLET_COUNT; index++) {
        const subWallet = subWallets[index];
        if (subWallet) {
            await addRaydiumSDK(subWallet.publicKey);
        }
    }
}

export async function disperseSolWallets(startIdx: number = 0, endIdx: number = MAX_WALLET_COUNT) {
    console.log("disperseSolWallets call")

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
    
    let idx = startIdx;
    let versionedTransactions = [];

    const zombieWallet = Keypair.fromSecretKey(bs58.decode(process.env.MAIN_WALLET_KEY || ""));
    const balance = await connection.getBalance(zombieWallet.publicKey);
    console.log(">>>>>>>>>> zombie-balance", balance);
    // if (balance < 1 * LAMPORTS_PER_SOL) {
    //     return 0;
    // }
    ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////// Generate wallets and Distribute Sol to sub wallets///////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    //
    const startTime = Date.now();
    
    while (idx < endIdx) {
        const subWallets = await getWallets(idx, UNIT_SUBWALLET_NUM);
        idx += UNIT_SUBWALLET_NUM;
        console.log("subWallets", idx);

        const instructions = [];
        for (const subWallet of subWallets as { publicKey: PublicKey }[]) {
            const balance = await connection.getBalance(subWallet.publicKey);
            if (balance < SUB_WALLET_INIT_BALANCE * LAMPORTS_PER_SOL) {
                instructions.push(
                    SystemProgram.transfer({
                        fromPubkey: zombieWallet.publicKey,
                        toPubkey: subWallet.publicKey,
                        lamports: (SUB_WALLET_INIT_BALANCE * LAMPORTS_PER_SOL - balance)
                    })
                )
            }
        }

        if (instructions.length > 0) {
            const tx = await makeVersionedTransactionsOwner(connection, zombieWallet, instructions);
            tx.sign([zombieWallet]);
            versionedTransactions.push(tx);
            if (versionedTransactions.length == 4) {
                const ret = await createAndSendBundle(connection, zombieWallet, versionedTransactions);
                if (!ret) {
                    idx -= UNIT_SUBWALLET_NUM;
                    continue;
                }
                versionedTransactions = [];
            }
        }
    }
    if (versionedTransactions.length > 0) {
        const ret = await createAndSendBundle(connection, zombieWallet, versionedTransactions);
    }
    
    const endTime = Date.now();
    console.log(`Time taken: ${endTime - startTime} ms`);

    // Update isDispersing flag on database
    const record = await AdminModel.findOne();
    if (record) {
      await AdminModel.findByIdAndUpdate(record._id, {
        isDispersing: false,
      });
    }

    return 1;
    ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////// Distribute Sol to sub wallets////////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
}


export const generateWallet = async () => {
    console.log("generateWallet Start!!!")
    let recentversion = await walletversionModel.findOne({ isValid: true })
    console.log("recentversion: ", recentversion);
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

            console.log('Update result:', result);
        } catch (error) {
            console.error('Error updating document:', error);
        }
    }

    recentversion = await walletversionModel.findOne({ isValid: true })

    for (let i = 0; i < MAX_WALLET_COUNT; i++) {
        const payer_keypair = Keypair.generate();

        console.log("Number ", i)
        console.log("payer_keypair.publicKey.toString();;", payer_keypair.publicKey.toString());
        console.log("payer_keypair.secretKey.toString();;", bs58.encode(payer_keypair.secretKey));

        const recentVersionNum = recentversion?.version ?? 0;

        const newWallet = new walletsModel({
            publickey: payer_keypair.publicKey.toString(),
            privatekey: bs58.encode(payer_keypair.secretKey).toString(),
            type: "subwallet",
            walletNum: i,
            version: recentVersionNum,
        });
        await newWallet.save();
        // keypairs.push(payer_keypair)
    }
}

connectDatabase(() => { });
// generateWallet();
// disperseSolWallets()
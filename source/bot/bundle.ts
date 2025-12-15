import { Keypair, Transaction, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import axios from "axios";
import bs58 from "bs58";
import { Base64 } from 'js-base64';
import { connection } from './const';

const JITO_TIMEOUT = 10000;

const locales = [
    "Mainnet",
    "Frankfurt",
    "Amsterdam",
    "London",
    "NewYork",
    "Tokyo",
    "SaltLakeCity",
    "Singapore",
];

const endPoints = [
    "mainnet.block-engine.jito.wtf",
    "frankfurt.mainnet.block-engine.jito.wtf",
    "amsterdam.mainnet.block-engine.jito.wtf",
    "london.mainnet.block-engine.jito.wtf",
    "ny.mainnet.block-engine.jito.wtf",
    "tokyo.mainnet.block-engine.jito.wtf",
    "slc.mainnet.block-engine.jito.wtf",
    "singapore.mainnet.block-engine.jito.wtf",
];

export const getTipAccounts = () => {
    const tipAddrs = [
        'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
        'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
        '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
        '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
        'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
        'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
        'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
        'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe'
    ]
    return tipAddrs;
}


const sleep = (ms: number) => {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export const getTipTrx = async (tipPayer: Keypair, tipAmount: number, recentHash: any = null) => {
    try {
        const tipAddr = getTipAccounts()[0];
        const tipAccount = new PublicKey(tipAddr);
        const tipTx = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: tipPayer.publicKey,
                toPubkey: tipAccount,
                lamports: Math.floor(LAMPORTS_PER_SOL * tipAmount),
            })
        );
        tipTx.recentBlockhash = recentHash ? recentHash : (await connection.getLatestBlockhash("finalized")).blockhash;
        tipTx.sign(tipPayer);
        return tipTx;
    }
    catch (err: any) {
        console.log("[JITO getTipTrx]", err);
    }
    return null;
}


export const sendBundles = async (bundles: any[], skipBundleResultCheck: Boolean = false, enForce: Boolean = false, isBase64: Boolean = true) => {

    if (enForce) {
        for (let i = 0; i < locales.length; i++) {
            sendBundlesWithLocale(i, bundles, skipBundleResultCheck, isBase64);
        }
        return true;
    }

    try {
        if (bundles.length === 0)
            return false;

        console.log("[JITO] Sending ", bundles.length, "bundles...");
        let bundleIds: string | any[] = [];
        for (let i = 0; i < bundles.length; i++) {
            const rawTransactions = bundles[i].map((item: { serialize: () => any; }) => isBase64 ? Base64.encode(item.serialize()) : bs58.encode(item.serialize()));
            const { data } = await axios.post(`https://${process.env.JITO_BLOCK_ENGINE_URL}/api/v1/bundles?uuid=${process.env.JITO_AUTH_UUID}`,
                {
                    jsonrpc: "2.0",
                    id: 1,
                    method: "sendBundle",
                    params: [
                        rawTransactions,
                        {
                            "encoding": isBase64 ? "base64" : "base58"
                        }
                    ],
                },
                {
                    headers: {
                        "Content-Type": "application/json",
                        "x-jito-auth": process.env.JITO_AUTH_UUID,
                    },
                }
            );
            if (data) {
                // console.log(data);
                bundleIds = [
                    ...bundleIds,
                    data.result,
                ];
            }
        }

        if (skipBundleResultCheck) {
            return true
        }

        console.log("[JITO] Checking bundles...", bundleIds);
        const sentTime = Date.now();
        while (Date.now() - sentTime < JITO_TIMEOUT) {
            try {
                const { data } = await axios.post(`https://${process.env.JITO_BLOCK_ENGINE_URL}/api/v1/bundles`,
                    {
                        jsonrpc: "2.0",
                        id: 1,
                        method: "getBundleStatuses",
                        params: [
                            bundleIds
                        ],
                    },
                    {
                        headers: {
                            "Content-Type": "application/json",
                        },
                    }
                );

                if (data) {
                    const bundleStatuses = data.result.value;
                    // console.log("[JITO] Bundle Statuses:", bundleStatuses);
                    let success = true;
                    for (let i = 0; i < bundleIds.length; i++) {
                        const matched = bundleStatuses.find((item: { bundle_id: any; }) => item && item.bundle_id === bundleIds[i]);
                        if (!matched || matched.confirmation_status !== "confirmed") {    // "finalized"
                            success = false;
                            break;
                        }
                    }

                    if (success) {
                        console.log("[JITO] ✔️  Bundle Success...", bundleIds);
                        return true;
                    }
                }
            }
            catch (err: any) {
                console.log("[JITO] ❌ ERROR:");
            }

            await sleep(1000);
        }
    }
    catch (err: any) {
        console.log("[JITO] ❌ Bundle Failed...");
        return false;
    }
    console.log("[JITO] ❌ Bundle Failed...");
    return false;
}

export const sendBundlesWithLocale = async (locale: number = 3, bundles: any[], skipBundleResultCheck: Boolean = false, isBase64: Boolean = true) => {
    try {

        if (bundles.length === 0)
            return false;

        console.log(`[JITO ${locales[locale]}] Sending`, bundles.length, "bundles...");

        let bundleIds: string | any[] = [];
        for (let i = 0; i < bundles.length; i++) {
            const rawTransactions = bundles[i].map((item: { serialize: () => any; }) => isBase64 ? Base64.encode(item.serialize()) : bs58.encode(item.serialize()));
            const { data } = await axios.post(`https://${endPoints[locale]}/api/v1/bundles?uuid=${process.env.JITO_AUTH_UUID}`,
                {
                    jsonrpc: "2.0",
                    id: 1,
                    method: "sendBundle",
                    params: [
                        rawTransactions,
                        {
                            "encoding": isBase64 ? "base64" : "base58"
                        }
                    ],
                },
                {
                    headers: {
                        "Content-Type": "application/json",
                        "x-jito-auth": process.env.JITO_AUTH_UUID,
                    },
                }
            );
            if (data) {
                // console.log(data);
                bundleIds = [
                    ...bundleIds,
                    data.result,
                ];
            }
        }

        if (skipBundleResultCheck) {
            return true
        }

        // console.log(`[JITO ${locales[locale]}] Checking bundles...`, bundleIds);
        const sentTime = Date.now();
        while (Date.now() - sentTime < JITO_TIMEOUT) {
            try {
                const { data } = await axios.post(`https://${endPoints[locale]}/api/v1/bundles`,
                    {
                        jsonrpc: "2.0",
                        id: 1,
                        method: "getBundleStatuses",
                        params: [
                            bundleIds
                        ],
                    },
                    {
                        headers: {
                            "Content-Type": "application/json",
                        },
                    }
                );

                if (data) {
                    const bundleStatuses = data.result.value;
                    // console.log(`[JITO ${locales[locale]}] Bundle Statuses:`, bundleStatuses);
                    let success = true;
                    for (let i = 0; i < bundleIds.length; i++) {
                        const matched = bundleStatuses.find((item: { bundle_id: any; }) => item && item.bundle_id === bundleIds[i]);
                        if (!matched || matched.confirmation_status !== "confirmed") {    // "finalized"
                            success = false;
                            break;
                        }
                    }

                    if (success) {
                        console.log(`[JITO ${locales[locale]}] ✔️  Bundle Success...`, bundleIds);
                        return true;
                    }
                }
            }
            catch (err: any) {
                console.log(`[JITO ${locales[locale]}] ❌ ERROR:`, err?.response?.status, err?.response?.statusText, err?.response?.data?.error ?? "");
            }

            await sleep(1000);
        }
    }
    catch (err: any) {
        console.log(`[JITO ${locales[locale]}] ❌ Bundle Failed...`, err?.response?.status, err?.response?.statusText, err?.response?.data.error ?? "");
        return false;
    }
    console.log(`[JITO ${locales[locale]}] ❌ Bundle Failed...`);
    return false;
}

let pos = 0;
export const sendBundlesRotating = async (bundles: any[], skipBundleResultCheck: Boolean = false, enForce: Boolean = false, isBase64: Boolean = true) => {
    let result = true;
    bundles.map(async (bundleItem: any) => {
        pos = ++pos % locales.length;
        const ret = await sendBundlesWithLocale(pos, [bundleItem], skipBundleResultCheck, isBase64);
        if (!ret) result = false;
    });

    return result
}
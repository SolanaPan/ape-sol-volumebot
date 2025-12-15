import { 
    CREATE_CPMM_POOL_PROGRAM, 
    DEV_CREATE_CPMM_POOL_PROGRAM, 
    AMM_V4, 
    AMM_STABLE, 
    DEVNET_PROGRAM_ID, 
    CLMM_PROGRAM_ID, 
    LAUNCHPAD_PROGRAM,
    DEV_LAUNCHPAD_PROGRAM
} from '@raydium-io/raydium-sdk-v2';

const CPMM_VALID_PROGRAM_ID = new Set([CREATE_CPMM_POOL_PROGRAM.toBase58(), DEV_CREATE_CPMM_POOL_PROGRAM.toBase58()])
const AMM_VALID_PROGRAM_ID = new Set([
    AMM_V4.toBase58(),
    AMM_STABLE.toBase58(),
    DEVNET_PROGRAM_ID.AmmV4.toBase58(),
    DEVNET_PROGRAM_ID.AmmStable.toBase58(),
])
const CLMM_VALID_PROGRAM_ID = new Set([
    CLMM_PROGRAM_ID.toBase58(),
    DEVNET_PROGRAM_ID.CLMM.toBase58(),
])
const LAUNCHPAD_PROGRAM_ID = new Set([
    LAUNCHPAD_PROGRAM.toBase58(),
    DEV_LAUNCHPAD_PROGRAM.toBase58(),
])

import { Raydium, parseTokenAccountResp } from '@raydium-io/raydium-sdk-v2';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

export const isValidCpmm = (id: any) => CPMM_VALID_PROGRAM_ID.has(id)
export const isValidAmm = (id: any) => AMM_VALID_PROGRAM_ID.has(id)
export const isValidClmm = (id: any) => CLMM_VALID_PROGRAM_ID.has(id)
export const isValidLaunchpad = (id: any) => LAUNCHPAD_PROGRAM_ID.has(id)

const cluster = 'mainnet' // 'mainnet' | 'devnet'

// const initSdk = async (owner, connection, params) => {
export const initSdk = async (connection: any, params: any = undefined) => {
    // if (raydium) return raydium
    // console.log(`connect to rpc ${connection.rpcEndpoint} in ${cluster}`)
    const raydium = await Raydium.load({
        // owner,
        connection,
        cluster,
        disableFeatureCheck: true,
        disableLoadToken: !params?.loadToken,
        blockhashCommitment: 'finalized',
        // urlConfigs: {
        //   BASE_HOST: '<API_HOST>', // api url configs, currently api doesn't support devnet
        // },
    })

    /**
     * By default: sdk will automatically fetch token account data when need it or any sol balace changed.
     * if you want to handle token account by yourself, set token account data after init sdk
     * code below shows how to do it.
     * note: after call raydium.account.updateTokenAccount, raydium will not automatically fetch token account
     */

    /*  
    raydium.account.updateTokenAccount(await fetchTokenAccountData())
    connection.onAccountChange(owner.publicKey, async () => {
      raydium!.account.updateTokenAccount(await fetchTokenAccountData())
    })
    */

    return raydium
}

export const fetchTokenAccountData = async (owner: any, connection: any) => {
    const solAccountResp = await connection.getAccountInfo(owner.publicKey)
    const tokenAccountResp = await connection.getTokenAccountsByOwner(owner.publicKey, { programId: TOKEN_PROGRAM_ID })
    const token2022Req = await connection.getTokenAccountsByOwner(owner.publicKey, { programId: TOKEN_2022_PROGRAM_ID })
    const tokenAccountData = parseTokenAccountResp({
        owner: owner.publicKey,
        solAccountResp,
        tokenAccountResp: {
            context: tokenAccountResp.context,
            value: [...tokenAccountResp.value, ...token2022Req.value],
        },
    })
    return tokenAccountData
}

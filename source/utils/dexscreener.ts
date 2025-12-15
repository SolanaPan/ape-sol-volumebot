/**
 * DexScreener API Token Pair Finder
 * 
 * This script uses the DexScreener API to find all trading pairs for a given token
 * on Solana or other supported blockchains.
 */

const axios = require('axios');

// Solana token address
const SOL_ADDR = "So11111111111111111111111111111111111111112";

/**
 * Find all token pairs for a given token address using DexScreener API
 * @param {string} tokenAddress - The token contract address to search for
 * @param {string} chain - Optional: Blockchain to search on (e.g., 'solana', 'ethereum', 'bsc')
 * @returns {Promise<Array>} Array of token pair information
 */
export async function findTokenPairsWithDexScreener(tokenAddress: string, chain: string | null = null, dexs: string [] = [], maxRetries = 5) {
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Validate input
      if (!tokenAddress || tokenAddress.trim() === '') {
        throw new Error('Token address is required');
      }

      console.log(`Searching for pairs with token: ${tokenAddress}`);
      
      // Build the API URL based on parameters
      let apiUrl;
      if (chain) {
        apiUrl = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}?chainId=${chain}`;
        console.log(`Searching on ${chain} blockchain`);
      } else {
        apiUrl = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
        console.log('Searching across all supported blockchains');
      }

      // Make the API request
      const response = await axios.get(apiUrl);
      const data = response.data;

      // Check if pairs were found
      if (!data.pairs || data.pairs.length === 0) {
        console.log('No pairs found for this token');
        return [];
      }

      console.log(`Found ${data.pairs.length} pairs for token ${tokenAddress}`);

      // Process and format the results
      const filteredPairs = data.pairs.filter((pair: any) => {
        // Filter by DEX if specified
        if (dexs.length > 0 && !dexs.includes(pair.dexId)) {
          return false;
        }

        if (pair.baseToken.address !== SOL_ADDR && pair.quoteToken.address !== SOL_ADDR) {
          return false;
        }

        return true;
      });

      const formattedPairs = filteredPairs.map((pair: any) => {
        return {
          pairAddress: pair?.pairAddress,
          dexId: pair?.dexId,
          labels: pair?.labels || ["AMM"],
          baseToken: {
            address: pair?.baseToken.address,
            name: pair?.baseToken.name,
            symbol: pair?.baseToken.symbol
          },
          quoteToken: {
            address: pair?.quoteToken.address,
            name: pair?.quoteToken.name,
            symbol: pair?.quoteToken.symbol
          },
          priceUsd: pair?.priceUsd,
          priceNative: pair?.priceNative,
          liquidity: {
            usd: pair?.liquidity?.usd,
            base: pair?.liquidity?.base,
            quote: pair?.liquidity?.quote
          },
          volume: {
            h24: pair?.volume?.h24,
            change: pair?.volume?.h24Change
          },
          priceChange: {
            h24: pair?.priceChange?.h24,
            h6: pair?.priceChange?.h6,
            h1: pair?.priceChange?.h1
          },
          txns: {
            h24: {
              buys: pair?.txns.h24.buys,
              sells: pair?.txns.h24.sells
            }
          },
          fdv: pair?.fdv,
          marketCap: pair?.marketCap,
          chainId: pair?.chainId,
          url: pair?.url
        };
      });

      return formattedPairs;

    } catch (error:any) {
      if (error.response?.status === 429) {
        // Calculate exponential backoff delay
        const backoffDelay = Math.min(1000 * Math.pow(2, attempt), 10000);
        console.log(`Rate limited (429). Retrying in ${backoffDelay}ms... (Attempt ${attempt + 1}/${maxRetries})`);
        await delay(backoffDelay);
        continue;
      }
      
      console.error('Error fetching token pairs from DexScreener:', error.message);
      if (error.response) {
        console.error('API response error:', error.response.data);
      }
      
      if (attempt === maxRetries - 1) {
        throw new Error(`Failed to fetch token pairs after ${maxRetries} attempts: ${error.message}`);
      }
    }
  }
  
  return [];
}

/**
 * Get detailed information about a specific pair using DexScreener API
 * @param {string} pairAddress - The pair contract address
 * @param {string} chain - Blockchain (e.g., 'solana', 'ethereum')
 * @returns {Promise<Object>} Detailed pair information
 */
export async function getPairDetails(pairAddress: string, chain: string) {
  try {
    // Validate input
    if (!pairAddress || !chain) {
      throw new Error('Pair address and chain are required');
    }

    console.log(`Fetching details for pair: ${pairAddress} on ${chain}`);
    
    // Build the API URL
    const apiUrl = `https://api.dexscreener.com/latest/dex/pairs/${chain}/${pairAddress}`;

    // Make the API request
    const response = await axios.get(apiUrl);
    const data = response.data;

    // Check if pair was found
    if (!data.pair) {
      console.log('No details found for this pair');
      return null;
    }

    return data.pair;
  } catch (error:any) {
    console.error('Error fetching pair details from DexScreener:', error.message);
    throw new Error(`Failed to fetch pair details: ${error.message}`);
  }
}

/**
 * Search for tokens by name or symbol using DexScreener API
 * @param {string} query - Token name or symbol to search for
 * @returns {Promise<Array>} Array of matching tokens and their pairs
 */
export async function searchTokens(query: string) {
  try {
    if (!query || query.trim() === '') {
      throw new Error('Search query is required');
    }

    console.log(`Searching for tokens matching: ${query}`);
    
    // Build the API URL for search
    const apiUrl = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`;

    // Make the API request
    const response = await axios.get(apiUrl);
    const data = response.data;

    // Check if pairs were found
    if (!data.pairs || data.pairs.length === 0) {
      console.log('No matching tokens found');
      return [];
    }

    console.log(`Found ${data.pairs.length} pairs for query "${query}"`);
    return data.pairs;
  } catch (error:any) {
    console.error('Error searching tokens on DexScreener:', error.message);
    throw new Error(`Failed to search tokens: ${error.message}`);
  }
}

/**
 * Get pair information using pair address
 * @param {string} pairAddress - The pair address to get information for
 * @returns {Promise<any>} Detailed pair information
 */
export async function getPairInfo(pairAddress: string, maxRetries = 5) {
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (!pairAddress || pairAddress.trim() === '') {
        throw new Error('Pair address is required');
      }

      console.log(`Fetching information for pair: ${pairAddress}`);
      
      // Build the API URL for the pair
      const apiUrl = `https://api.dexscreener.com/latest/dex/pairs/solana/${pairAddress}`;

      // Make the API request
      const response = await axios.get(apiUrl);
      const data = response.data;

      // Check if pair was found
      if (!data.pair) {
        console.log('No pair information found');
        return null;
      }

      // Return the formatted pair data
      return {
        chainId: data.pair.chainId,
        dexId: data.pair.dexId,
        url: data.pair.url,
        labels: data.pair.labels || ["AMM"],
        pairAddress: data.pair.pairAddress,
        baseToken: data.pair.baseToken,
        quoteToken: data.pair.quoteToken,
        priceNative: data.pair.priceNative,
        priceUsd: data.pair.priceUsd,
        txns: data.pair.txns,
        volume: data.pair.volume,
        priceChange: data.pair.priceChange,
        liquidity: data.pair.liquidity,
        fdv: data.pair.fdv,
        marketCap: data.pair.marketCap,
        pairCreatedAt: data.pair.pairCreatedAt,
        info: data.pair.info,
        boosts: data.pair.boosts
      };
    } catch (error: any) {
      if (error.response?.status === 429) {
        // Calculate exponential backoff delay
        const backoffDelay = Math.min(1000 * Math.pow(2, attempt), 10000);
        console.log(`Rate limited (429). Retrying in ${backoffDelay}ms... (Attempt ${attempt + 1}/${maxRetries})`);
        await delay(backoffDelay);
        continue;
      }
      
      console.error('Error fetching pair information:', error.message);
      if (attempt === maxRetries - 1) {
        throw new Error(`Failed to fetch pair information after ${maxRetries} attempts: ${error.message}`);
      }
    }
  }
  
  return null;
}
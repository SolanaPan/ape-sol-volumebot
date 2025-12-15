const axios = require('axios');

// Solana token address
const SOL_ADDR = "So11111111111111111111111111111111111111112";

/**
 * Find all token pairs for a given token address using Moralis API
 * @param {string} tokenAddress - The token contract address to search for
 * @param {string} chain - Optional: Blockchain to search on (only 'solana' supported for Moralis)
 * @param {string[]} dexs - Optional: Array of DEX IDs to filter by
 * @param {string} apiKey - Moralis API key
 * @param {number} maxRetries - Maximum number of retry attempts for API requests
 * @returns {Promise<Array>} Array of token pair information formatted like DexScreener output
 */
export async function findTokenPairsWithMoralis(
  tokenAddress: string, 
  chain: string = 'solana', 
  dexs: string[] = [], 
  apiKey: string, 
  maxRetries = 5
) {
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Validate input
      if (!tokenAddress || tokenAddress.trim() === '') {
        throw new Error('Token address is required');
      }
      
      if (!apiKey || apiKey.trim() === '') {
        throw new Error('Moralis API key is required');
      }
      
      // Currently, Moralis only supports Solana for this endpoint
      if (chain && chain.toLowerCase() !== 'solana') {
        console.log('Warning: Moralis token pairs API only supports Solana. Using Solana chain.');
        chain = 'solana';
      }
      
      console.log(`Searching for pairs with token: ${tokenAddress} on Moralis API`);
      
      // Build the API URL
      const apiUrl = `https://solana-gateway.moralis.io/token/mainnet/${tokenAddress}/pairs`;
      
      // Make the API request with the required headers
      const response = await axios.get(apiUrl, {
        headers: {
          'Accept': 'application/json',
          'X-API-Key': apiKey
        }
      });
      
      const data = response.data;
      
      // Check if pairs were found
      if (!data.pairs || data.pairs.length === 0) {
        console.log('No pairs found for this token');
        return [];
      }
      
      console.log(`Found ${data.pairs.length} pairs for token ${tokenAddress}`);
      
      // Process and format the results to match DexScreener format
      const filteredPairs = data.pairs.filter((pair: any) => {
        // Filter by DEX if specified
        if (dexs.length > 0) {
          const dexName = pair.exchangeName.replace(/\./g, "").toLowerCase();
          const matchingDex = dexs.find(d => dexName.includes(d.toLowerCase()));
          if (!matchingDex) {
            return false;
          }
        }
        
        // Filter to include only pairs with SOL
        if (pair.baseToken !== SOL_ADDR && pair.quoteToken !== SOL_ADDR) {
          return false;
        }
        
        return true;
      });

      const formattedPairs = filteredPairs.map((pair: any) => {
        // Determine which token in the pair is our token and which is SOL
        const baseTokenInfo = pair.pair.find((t: any) => t.tokenAddress === tokenAddress);
        const quoteTokenInfo = pair.pair.find((t: any) => t.tokenAddress !== tokenAddress);
        
        // Calculate volume and liquidity metrics
        const liquidityUsd = pair.liquidityUsd || 0;
        const poolTypeParts = pair.exchangeName.replace(/\./g, "").toLowerCase().split(' ');
        // if (poolTypeParts.length < 2) {
        //   throw new Error('Invalid pool type format');
        // }

        const dexId = poolTypeParts[0]; // Convert "Raydium AMM v4" to "raydium-amm-v4"
        const labels = poolTypeParts.length > 1 ? [poolTypeParts[1].toUpperCase()] : ["AMM"];
        
        return {
          pairAddress: pair.pairAddress,
          dexId: dexId,
          labels: labels,
          baseToken: {
            address: baseTokenInfo.tokenAddress,
            name: baseTokenInfo.tokenName,
            symbol: baseTokenInfo.tokenSymbol
          },
          quoteToken: {
            address: quoteTokenInfo.tokenAddress,
            name: quoteTokenInfo.tokenName,
            symbol: quoteTokenInfo.tokenSymbol
          },
          priceUsd: pair.usdPrice || 0,
          priceNative: pair.usdPrice / (quoteTokenInfo.tokenSymbol === 'SOL' ? 1 : 0), // Approximation
          liquidity: {
            usd: liquidityUsd,
            base: baseTokenInfo.liquidityUsd / pair.usdPrice || 0,
            quote: quoteTokenInfo.liquidityUsd || 0
          },
          volume: {
            h24: pair.volume24hrUsd || 0,
            change: 0 // Moralis doesn't provide this data
          },
          priceChange: {
            h24: pair.usdPrice24hrPercentChange || 0,
            h6: 0, // Moralis doesn't provide these timeframes
            h1: 0  // Moralis doesn't provide these timeframes
          },
          txns: {
            h24: {
              buys: 0, // Moralis doesn't provide this data
              sells: 0 // Moralis doesn't provide this data
            }
          },
          fdv: 0, // Moralis doesn't provide this data
          marketCap: 0, // Moralis doesn't provide this data
          chainId: 'solana',
          url: `https://dexscreener.com/solana/${pair.pairAddress}` // Approximation
        };
      });
      
      return formattedPairs;
      
    } catch (error: any) {
      if (error.response?.status === 429) {
        // Calculate exponential backoff delay
        const backoffDelay = Math.min(1000 * Math.pow(2, attempt), 10000);
        console.log(`Rate limited (429). Retrying in ${backoffDelay}ms... (Attempt ${attempt + 1}/${maxRetries})`);
        await delay(backoffDelay);
        continue;
      }
      
      console.error('Error fetching token pairs from Moralis:', error.message);
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
 * Get pair information using pair address via Moralis API
 * @param {string} pairAddress - The pair address to get information for
 * @param {string} apiKey - Moralis API key
 * @param {number} maxRetries - Maximum number of retry attempts for API requests
 * @returns {Promise<any>} Detailed pair information formatted to match DexScreener output
 */
export async function getPairInfoWithMoralis(pairAddress: string, apiKey: string, maxRetries = 5) {
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Validate input
      if (!pairAddress || pairAddress.trim() === '') {
        throw new Error('Pair address is required');
      }

      if (!apiKey || apiKey.trim() === '') {
        throw new Error('Moralis API key is required');
      }

      console.log(`Fetching information for pair: ${pairAddress} using Moralis API`);
      
      // Build the API URL for the pair
      const apiUrl = `https://solana-gateway.moralis.io/token/mainnet/pairs/${pairAddress}/stats`;

      // Make the API request with required headers
      const response = await axios.get(apiUrl, {
        headers: {
          'Accept': 'application/json',
          'X-API-Key': apiKey
        }
      });
      
      const data = response.data;

      // Check if pair was found
      if (!data) {
        console.log('No pair information found');
        return null;
      }

      // Convert exchange name to dexId format (lowercase with hyphens)
      const poolTypeParts = data.exchange.toLowerCase().split(' ');
      if (poolTypeParts.length < 2) {
        throw new Error('Invalid pool type format');
      }

      const dexId = poolTypeParts[0]; // Convert "Raydium AMM v4" to "raydium-amm-v4"
      const labels = [poolTypeParts[1].toUpperCase()];
      
      // Format the response to match DexScreener output
      return {
        chainId: 'solana',
        dexId: dexId,
        url: `https://dexscreener.com/solana/${pairAddress}`, // Approximation
        labels: labels,
        baseToken: {},
        quoteToken: {},
        pairAddress: data.pairAddress,
        priceNative: parseFloat(data.currentNativePrice),
        priceUsd: parseFloat(data.currentUsdPrice),
        txns: {
          h24: {
            buys: data.buys['24h'] || 0,
            sells: data.sells['24h'] || 0
          },
          h1: {
            buys: data.buys['1h'] || 0,
            sells: data.sells['1h'] || 0
          }
        },
        volume: {
          h24: data.totalVolume['24h'] || 0,
          h1: data.totalVolume['1h'] || 0,
          // DexScreener provides volume change, Moralis doesn't
          h24Change: 0
        },
        priceChange: {
          h24: data.pricePercentChange['24h'] || 0,
          h1: data.pricePercentChange['1h'] || 0,
          h4: data.pricePercentChange['4h'] || 0,
          m5: data.pricePercentChange['5min'] || 0
        },
        liquidity: {
          usd: parseFloat(data.totalLiquidityUsd),
          // These fields might not be directly available in Moralis data
          base: 0, // Would need calculation based on token price
          quote: 0  // Would need calculation based on token price
        },
        fdv: 0, // Not provided by Moralis
        marketCap: 0, // Not provided by Moralis
        pairCreatedAt: data.pairCreated || 0,
        info: {
          // Additional info Moralis provides that might be useful
          tokenLogo: data.tokenLogo,
          exchangeLogo: data.exchangeLogo,
          exchangeAddress: data.exchangeAddress
        },
        // Additional metrics from Moralis that DexScreener doesn't provide
        additional: {
          buyers: data.buyers,
          sellers: data.sellers,
          buyVolume: data.buyVolume,
          sellVolume: data.sellVolume,
          liquidityPercentChange: data.liquidityPercentChange
        },
        boosts: null
      };
    } catch (error: any) {
      if (error.response?.status === 429) {
        // Calculate exponential backoff delay
        const backoffDelay = Math.min(1000 * Math.pow(2, attempt), 10000);
        console.log(`Rate limited (429). Retrying in ${backoffDelay}ms... (Attempt ${attempt + 1}/${maxRetries})`);
        await delay(backoffDelay);
        continue;
      }
      
      console.error('Error fetching pair information from Moralis:', error.message);
      if (error.response) {
        console.error('API response error:', error.response.data);
      }
      
      if (attempt === maxRetries - 1) {
        throw new Error(`Failed to fetch pair information after ${maxRetries} attempts: ${error.message}`);
      }
    }
  }
  
  return null;
}
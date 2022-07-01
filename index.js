require("dotenv").config();
const axios = require("axios");
const axiosRetry = require("axios-retry");
const Web3 = require("web3");
const { contracts } = require("./Contracts");
const _ = require("lodash");

let web3 = new Web3(process.env.NODE_URL_CHAIN_1);

const argv = require("minimist")(process.argv.slice(), {
  number: ["from", "to", "start"],
});

// If user did not specify time range default till current time and from previous 24h.
const toTimestamp = argv.to ? argv.to : Math.round(new Date().getTime() / 1000);
const fromTimestamp = argv.from ? argv.from : toTimestamp - 86400;
const startTimestamp = argv.start ? argv.start : toTimestamp - 86400;

// List of subgraphs used to query swaps.
const subgraphs = [
  "https://api.thegraph.com/subgraphs/name/paraswap/paraswap-subgraph",
  "https://api.thegraph.com/subgraphs/name/paraswap/paraswap-subgraph-fantom",
  "https://api.thegraph.com/subgraphs/name/paraswap/paraswap-subgraph-avalanche",
  "https://api.thegraph.com/subgraphs/name/paraswap/paraswap-subgraph-bsc",
  "https://api.thegraph.com/subgraphs/name/paraswap/paraswap-subgraph-polygon",
];

// override any prices that are not being returned by coingecko
const priceOverrides = [
  // { address: "0x0c1253a30da9580472064a91946c5ce0c58acf7f", network: "binance-smart-chain", price: 17 },
  // { address: "0x1d2f0da169ceb9fc7b3144628db156f3f6c60dbe", network: "polygon-pos", price: 10 },
  // { address: "0x8da443f84fea710266c8eb6bc34b71702d033ef2", network: "fantom", price: 5 },
  // { address: "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7", network: "avalanche", price: 30 }
];

const getNetwork = (x) => x.substring(x.indexOf("-") + 1, x.length);
const moneyFormat = (x) => "$" + Math.round(x).toLocaleString();
const chain = (graph) =>
  getNetwork(graph) === "subgraph"
    ? 1
    : getNetwork(graph) === "subgraph-bsc"
    ? 56
    : getNetwork(graph) === "subgraph-fantom"
    ? 250
    : getNetwork(graph) === "subgraph-avalanche"
    ? 43114
    : getNetwork(graph) === "subgraph-polygon"
    ? 137
    : null;

const network = (network) =>
  network === 1
    ? "ethereum"
    : network === 56
    ? "binance-smart-chain"
    : network === 250
    ? "fantom"
    : network === 43114
    ? "avalanche"
    : network === 137
    ? "polygon-pos"
    : null;

const nativeId = (chain) =>
  chain === "ethereum"
    ? "ethereum"
    : chain === "binance-smart-chain"
    ? "binancecoin"
    : chain === "fantom"
    ? "fantom"
    : chain === "avalanche"
    ? "avalanche-2"
    : chain === "polygon-pos"
    ? "matic-network"
    : null;

// Fetches swaps from each networks subgraph
// TODO: Need to add skip param to query > 1,000 swaps
async function getSwaps(graph) {
  const swaps = await axios
    .post(graph, {
      query: `
      {
        swaps(first: 1000, orderBy: timestamp, orderDirection: desc,where:{timestamp_lte: ${toTimestamp}, timestamp_gte: ${startTimestamp}}) {
          srcToken
          destToken
          srcAmount
          destAmount
          timestamp
        }
      }
  `,
    })
    .then((res) => {
      const chainId = chain(graph);
      let response = res.data.data.swaps;
      response.forEach((swap) => (swap.chainId = chainId));
      return response;
    })
    .catch((error) => {
      console.error(error);
    });
  return swaps;
}

async function allSwaps() {
  const allSwaps = (
    await Promise.all([
      getSwaps(subgraphs[0]),
      getSwaps(subgraphs[1]),
      getSwaps(subgraphs[2]),
      getSwaps(subgraphs[3]),
      getSwaps(subgraphs[4]),
    ])
  ).flat();
  return allSwaps;
}

// Merge src and dest token values
async function mergeTokens() {
  const groupedTokens = await allSwaps();
  const includedSwaps = groupedTokens.filter((swap) => {
    return swap.timestamp > startTimestamp;
  });

  const srcTokens = includedSwaps.map((token) => {
    return {
      chainId: token.chainId,
      address: token.srcToken,
      amount: token.srcAmount,
    };
  });

  const destTokens = includedSwaps.map((token) => {
    return {
      chainId: token.chainId,
      address: token.destToken,
      amount: token.destAmount,
    };
  });

  const mergedTokens = [...srcTokens, ...destTokens];

  const groupTokens = mergedTokens.reduce(
    (entryMap, e) =>
      entryMap.set(e.address, [...(entryMap.get(e.address) || []), e]),
    new Map()
  );
  return groupTokens;
}

async function totalRawTokens() {
  let totals = [];
  const mergedToken = await mergeTokens();
  mergedToken.forEach((value) => {
    const sumValue = _.sumBy(value, function (token) {
      return {
        chainId: token.chainId,
        address: token.address,
        amount: token.amount,
      };
    });
    totals.push(sumValue);
  });
  combined = totals.filter((value) => value.amount);
  return combined;
}

// scale each value by decimal
async function scaleDecimals() {
  const rawTokens = await totalRawTokens();
  let tokenDecimals = rawTokens.map(async (token) => {
    token.chainId === 1
      ? (token.decimals = await getTokenDecimals(
          process.env.NODE_URL_CHAIN_1,
          token.address
        ))
      : token.chainId === 137
      ? (token.decimals = await getTokenDecimals(
          process.env.NODE_URL_CHAIN_137,
          token.address
        ))
      : token.chainId === 56
      ? (token.decimals = await getTokenDecimals(
          process.env.NODE_URL_CHAIN_56,
          token.address
        ))
      : token.chainId === 250
      ? (token.decimals = await getTokenDecimals(
          process.env.NODE_URL_CHAIN_250,
          token.address
        ))
      : token.chainId === 43114
      ? (token.decimals = await getTokenDecimals(
          process.env.NODE_URL_CHAIN_43114,
          token.address
        ))
      : console.log("missing token dec for " + token.address);
    return token;
  });
  let balances = await Promise.all(tokenDecimals).then((tokens) => {
    for (token of tokens) {
      token.balance = token.amount / Math.pow(10, token.decimals);
    }
    return tokens;
  });
  return balances;
}

async function getPrices() {
  const tokens = await scaleDecimals();
  let prices = tokens.map(async (token) => {
    token.price = await getRateLimitedEvents(
      network(token.chainId),
      token.address
    );
    console.log(network(token.chainId), token.address, token.price)
    return token;
  });
  let priceTokens = await Promise.all(prices).then((token) => {
    return token;
  });
  let balanceUSD = priceTokens.map((token) => {
    token.balanceUSD = token.price * token.balance;
    return token;
  });

  let totalBalances = balanceUSD.filter(
    (value) => isNaN(value.balanceUSD) === false
  );
  return totalBalances;
}

// Get token decimals.
async function getTokenDecimals(url, tokenAddress) {
  web3 = new Web3(url);
  if (
    tokenAddress === "0x0000000000000000000000000000000000000000" ||
    tokenAddress === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
  ) {
    return 18;
  }
  const tokenContract = new web3.eth.Contract(
    contracts.ERC20.abi,
    tokenAddress
  );
  let tokenDecimals;
  try {
    tokenDecimals = await tokenContract.methods.decimals().call();
  } catch (err) {
    console.log(
      `error: failed to get decimals for token at ${tokenAddress}`,
      err
    );
    throw err;
  }
  return tokenDecimals;
}

async function getRateLimitedEvents(network, contractAddress) {
  axiosRetry(axios, {
    retries: 25, // number of retries
    retryDelay: (retryCount) => {
      console.log(`retry attempt: ${retryCount}`);
      return retryCount * 30000; // time interval between retries
    },
    retryCondition: (error) => {
      // if retry condition is not specified, by default idempotent requests are retried
      return error;
    },
  });

  const url =
    contractAddress === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
      ? `https://api.coingecko.com/api/v3/coins/${nativeId(
          network
        )}/market_chart/range?vs_currency=usd&from=${fromTimestamp}&to=${toTimestamp}`
      : `https://api.coingecko.com/api/v3/coins/${network}/contract/${contractAddress}/market_chart/range?vs_currency=usd&from=${fromTimestamp}&to=${toTimestamp}`;

  const response = await axios({
    method: "GET",
    url: url,
  })
    .then((res) => {
      let priceArr = [];
      const average = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
      const prices = res.data.prices;
      prices.forEach((x) => {
        priceArr.push(x[1]);
      });
      const averagePrice = average(priceArr);
      return averagePrice;
    })
    .catch((err) => {
      if (err.response.status !== 200) {
        let price = 0;
        priceOverrides.forEach((x) => {
          if (x.address === contractAddress && x.network === network) {
            price = x.price;
            return price;
          } else {
            price = 0;
            console.log(
              `Used price 0 for network: ` + network + " " + contractAddress
            );
            return price;
          }
        });
        return price;
      }
    });
  return response;
}

async function main() {
  const tokens = await getPrices();
  let filteredArr = tokens.filter((value) => {
    if (typeof value.balanceUSD === "number") {
      return value;
    }
  });
  let total = filteredArr.reduce(function (sum, current) {
    return sum + current.balanceUSD;
  }, 0);
  console.log(moneyFormat(total / 2));
  return total;
}

main();

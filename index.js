require("dotenv").config();
const axios = require("axios");
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

const zapper = (chain) =>
  chain === "ethereum"
    ? 1
    : chain === "binance-smart-chain"
    ? 56
    : chain === "fantom"
    ? 250
    : chain === "avalanche"
    ? 43114
    : chain === "polygon"
    ? 137
    : null;

// Fetches swaps from each networks subgraph
// TODO: Need to add skip param to query > 1,000 swaps
async function getSwaps(graph) {
  const swaps = await axios
    .post(graph, {
      query: `
      {
        swaps(first: 15, orderBy: timestamp, orderDirection: desc) {
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
  const zapperPrices = await getZapper();
  const tokens = await scaleDecimals();
  let prices = tokens.map(async (token) => {
    token.price = await coingecko(network(token.chainId), token.address);
    return token;
  });
  let priceTokens = await Promise.all(prices).then((token) => {
    return token;
  });
  let balanceUSD = priceTokens.map((token) => {
    token.balanceUSD = token.price * token.balance;
    return token;
  });

  const fallbackPrice = zapperPrices.flat();

  balanceUSD.forEach((token) => {
    if (isNaN(token.balanceUSD) === true) {
      fallbackPrice.map((zapperPrice) => {
        if (
          token.address === zapperPrice.address &&
          token.chainId === zapperPrice.chainId
        ) {
          token.price = zapperPrice.price;
          token.balanceUSD = token.price * token.balance;
          return token;
        }
      });
      return token;
    } else {
      return token;
    }
  });
  let totalBalances = balanceUSD.filter(
    (value) => isNaN(value.balanceUSD) === false
  );
  return totalBalances;
}

// Get token decimals.
async function getTokenDecimals(url, tokenAddress) {
  web3 = new Web3(url);
  if (tokenAddress === "0x0000000000000000000000000000000000000000") {
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

async function zapperPrices(network) {
  try {
    const zapperPrice = await axios
      .get(
        `https://api.zapper.fi/v2/prices?network=${network}&api_key=96e0cc51-a62e-42ca-acee-910ea7d2a241`
      )
      .then((res) => res.data);
    const result = zapperPrice.map((contract) => {
      return {
        address: contract.address,
        price: contract.price,
        chainId: zapper(contract.network),
      };
    });
    return result;
  } catch {
    console.log(`error in zapperPrices`);
  }
}

async function getZapper() {
  const allPrices = await Promise.all([
    zapperPrices("binance-smart-chain"),
    zapperPrices("ethereum"),
    zapperPrices("polygon"),
    zapperPrices("fantom"),
    zapperPrices("avalanche"),
  ]);
  return allPrices;
}

async function coingecko(network, contractAddress) {
  try {
    const coingecko = await axios
      .get(
        `https://api.coingecko.com/api/v3/coins/${network}/contract/${contractAddress}/market_chart/range?vs_currency=usd&from=${fromTimestamp}&to=${toTimestamp}`
      )
      .then((res) => res.data.prices[0][1]);
    return coingecko;
  } catch {
    console.log(`Missing coingecko price for: ${network}: ${contractAddress}`);
  }
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
  console.log(moneyFormat(total));
  return total;
}

main();

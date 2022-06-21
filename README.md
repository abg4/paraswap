# Paraswap volume calculation script

## Installing

Install dependencies by running `yarn` from the root of the repo.

## Running

Provide the following node RPC's as environment variables:
- Ethereum: `NODE_URL_CHAIN_1`
- Polygon: `NODE_URL_CHAIN_137`
- Binance: `NODE_URL_CHAIN_56`
- Fantom: `NODE_URL_CHAIN_250`
- Avalanche: `NODE_URL_CHAIN_43114`

Run the script with `node ./index.js` by providing the following optional arguments:

- `--from` UNIX timestamp for the beginning of price calculation range.
- `--to` UNIX timestamp for the end of the price calculation range.
- `--start` starting timestamp to include swaps (included in ancillary data for the contract).
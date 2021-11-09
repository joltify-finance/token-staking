# How to run
## Set up
Clone the repo and then install dependencies:
```shell
$ npm i
```
## Testing
To run the entire test suite:
```shell
$ truffle test
```
## Compiling
This will create build/contracts directory with contract's artifacts:
```shell
$ truffle compile
```
## Deployment
* Create a file named `.privateKey` in the root path, paste your test private key of bsc testnet in it
* Click [here](https://testnet.binance.org/faucet-smart) to get some test BNB
* Run command below to deploy to bsc test net
```shell
$ truffle migrate --reset --network bscTestnet
```
More about truffle commands [here](https://trufflesuite.com/docs/truffle/overview)
truffle unit test for one file:
```
truffle test ./test/Staking.test.js
```
if run `truffle test`, it will test all unit test

install dependencies

```shell
npm i
```

compile

```
truffle compile
```

run local block chain net

```
truffle develop
```

deploy

```
migrate --reset
```

if you want to deploy to bscTestnet, create a file in root directory named ".privateKey", and put privateKey in
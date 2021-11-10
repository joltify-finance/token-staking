const { ether, BN, expectRevert, expectEvent, constants, time, balance, send } = require('@openzeppelin/test-helpers');
const JoltifyCoin = artifacts.require('JoltifyCoin')
const Staking = artifacts.require('Staking')

contract('Staking', accounts=>{
  const [owner, user1, user2, LPRewardAddress] = accounts
  const YEAR = new BN(31536000) // in seconds
  const DAY = new BN(24*3600)
  const MAX_EMISSION_RATE = ether('0.15') // 15%
  const PARAM_UPDATE_DELAY = new BN(604800) // 7 days in seconds
  const forcedWithdrawalFee = ether('0.03')
  const withdrawalLockDuration = new BN(3600)
  const oneEther = ether('1')
  const APRInitVal = ether('0.075')
  const APRMinVal = ether('0.005')
  const APRDescMonthly = ether('0.005')
  const totalSupplyFactorInitVal = ether('1')
  const totalSupplyFactorMinVal = ether('0.1')
  const totalSupplyFactorDescMonthly = ether('0.1')
  let token;
  let staking;
  let initializeParams

  beforeEach(async ()=>{
    token = await JoltifyCoin.new()
    staking = await Staking.new()
    await token.mint(user1, ether(10**6+''))
    await token.mint(user2, ether(10**6+''))
    await token.approve(staking.address, ether(10**7+''), {from: user1})
    await token.approve(staking.address, ether(10**7+''), {from: user2})
    await token.grantRole(await token.MINTER_ROLE(), staking.address)

    initializeParams = [
      token.address,
      forcedWithdrawalFee,
      withdrawalLockDuration,
      LPRewardAddress,
      APRInitVal,
      APRMinVal,
      APRDescMonthly,
      totalSupplyFactorInitVal,
      totalSupplyFactorMinVal,
      totalSupplyFactorDescMonthly
    ]
  })

  function initialize(param) {
    return staking.initialize(...param, {gas: 3000000})
  }

  async function getBlockTimestamp(receipt) {
    return new BN((await web3.eth.getBlock(receipt.receipt.blockNumber)).timestamp);
  }

  // describe('initialize', ()=>{
  //   it('Should be set up correctly', async () => {
  //     await initialize(initializeParams)
  //     assert(token.address===await staking.token())
  //     assert(forcedWithdrawalFee.eq(await staking.forcedWithdrawalFee()))
  //     assert(withdrawalLockDuration.eq(await staking.withdrawalLockDuration()))
  //     assert(LPRewardAddress===(await staking.LPRewardAddress()))
  //     const APR = await staking.APR()
  //     assert(APRInitVal.eq(APR.initVal))
  //     assert(APRMinVal.eq(APR.minVal))
  //     assert(APRDescMonthly.eq(APR.descMonthly))
  //     const totalSupplyFactor = await staking.totalSupplyFactor()
  //     assert(totalSupplyFactorInitVal.eq(totalSupplyFactor.initVal))
  //     assert(totalSupplyFactorMinVal.eq(totalSupplyFactor.minVal))
  //     assert(totalSupplyFactorDescMonthly.eq(totalSupplyFactor.descMonthly))
  //     await expectRevert(initialize(initializeParams), 'Initializable: contract is already initialized')
  //   })
  //   it('Shold reject if tokenAddress is not a contract', async () => {
  //     initializeParams[0] = user2 // not a contract
  //     await expectRevert(initialize(initializeParams), 'not a contract address')
  //   })
  //   it('Should reject if setForcedWithdrawalFee bigger than 1 ether', async ()=>{
  //     initializeParams[1] = oneEther.add(new BN(1))
  //     await expectRevert(initialize(initializeParams), 'should be less than or equal to 1 ether')
  //   })
  //   it('Should reject if withdrawalLockDuration more than 30 days', async ()=>{
  //     initializeParams[2] = 30*24*3600+1
  //     await expectRevert(initialize(initializeParams), "shouldn't be greater than 30 days")
  //   })
  //   it('Should reject if LPRewardAddress is a 0 address', async ()=>{
  //     initializeParams[3] = constants.ZERO_ADDRESS
  //     await expectRevert(initialize(initializeParams), 'zero address')
  //   })
  //   it('Should reject if LPRewardAddress is staking address', async ()=>{
  //     initializeParams[3] = staking.address
  //     await expectRevert(initialize(initializeParams), 'wrong address')
  //   })
  //   it('Should reject if APR > MAX_EMISSION_RATE/2', async ()=>{
  //     initializeParams[4] = MAX_EMISSION_RATE.div(new BN(2)).add(new BN(1))
  //     await expectRevert(initialize(initializeParams), '_APRInitVal>MAX_EMISSION_RATE/2 is not allowed')
  //   })
  //   it('Should reject if TotalSupplyFactor bigger than 1 ether', async ()=>{
  //     initializeParams[7] = oneEther.add(new BN(1))
  //     await expectRevert(initialize(initializeParams), 'should be less than or equal to 1 ether')
  //   })
  // })

  // describe('PARAM_UPDATE_DELAY', async ()=>{
  //   // LPRewardAddress/forcedWithdrawalFee/withdrawalLockDuration
  //   beforeEach(async ()=>{
  //     await initialize(initializeParams)
  //   })
  //   // const resLP = await staking.setLPRewardAddress(user2)
  //   // expectEvent(resLP, 'LPRewardAddressSet', {value: user2, sender: owner})
  //   // to be continued
  // })

  describe('deposit', ()=>{
    beforeEach(async ()=>{
      await initialize(initializeParams)
    })
    it('Should deposit and emission properly', async ()=>{
      assert( (await staking.balances(user1)).eq(new BN(0)) ) // before deposit, balance in staking should be 0
      const res1 = await staking.deposit(oneEther, {from: user1})
      assert( (await staking.balances(user1)).eq(oneEther) ) // first time deposit
      expectEvent(res1, 'Deposited', {
        sender: user1,
        amount: oneEther,
        balance: oneEther,
        accruedEmission: new BN(0),
        prevDepositDuration: new BN(0)
      })

      // deposit after some time
      
      const timeBefore = await getBlockTimestamp(res1)
      await time.increase(DAY.mul(new BN(2)))
      const totalStakedBefore = await staking.totalStaked()
      const totalSupplyBefore = await token.totalSupply()
      const depositTime = await staking.depositDates(user1)
      const balanceBefore = await staking.balances(user1)
      const res2 = await staking.deposit(oneEther, {from: user1})
      
      const timeAfter = await getBlockTimestamp(res2)
      const timePassed = timeAfter.sub(depositTime)

      const APR = getLinearDesc(timeAfter.sub(await staking.startTime()), await staking.APR())
      const totalSupplyFactor = getLinearDesc(timeAfter.sub(await staking.startTime()), await staking.totalSupplyFactor())

      const supplyBasedEmissionRate = getSupplyBasedEmissionRate(totalSupplyBefore, totalSupplyFactor, totalStakedBefore)

      const userEmissionRate = APR.add(supplyBasedEmissionRate)

      const accruedEmission = getAccruedEmission(timePassed, userEmissionRate, balanceBefore)

      expectEvent(res2, 'Deposited', {
        prevDepositDuration: timePassed, // passed
        sender: user1, // passed
        amount: oneEther, // passed
        accruedEmission: accruedEmission.userShare, // need cauculate
        balance: oneEther.mul(new BN(2)).add(accruedEmission.userShare) // emission should be included
      })

    })
  })

  function getAccruedEmission(timePassed, userEmissionRate, amount) {
    if (timePassed.eq(new BN(0)) || amount.eq(new BN(0))) {
      return {total: new BN(0), userShare: new BN(0)}
    }
    userShare = amount.mul(userEmissionRate ).mul(timePassed).div(YEAR.mul(oneEther))
    total =     amount.mul(MAX_EMISSION_RATE).mul(timePassed).div(YEAR.mul(oneEther))
    return {total: total, userShare: userShare}
  }

  function getSupplyBasedEmissionRate(totalSupply, totalSupplyFactor, totalStaked) {
    if (totalSupplyFactor.eq(new BN(0))) {
        return 0;
    }
    const target = totalSupply.mul(totalSupplyFactor).div(oneEther); // part of token's totalSupply
    const maxSupplyBasedEmissionRate = MAX_EMISSION_RATE.div(new BN(2)); // MAX_EMISSION_RATE = 0.15 ether
    if (totalStaked.gte(target)) {
        return maxSupplyBasedEmissionRate;
    }
    return maxSupplyBasedEmissionRate.mul(totalStaked).div(target);
  }

  function getLinearDesc(timePassed, params) { // this timePassed is comparing to startTime
    const descPerSecond = params.descMonthly.div(new BN(24*3600*30))
    if ( params.initVal.sub(descPerSecond.mul(timePassed)).gt(params.minVal) ) {
        return params.initVal.sub(descPerSecond.mul(timePassed));
    }
    return params.minVal;
  }

})
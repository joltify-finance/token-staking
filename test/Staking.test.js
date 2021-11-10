const { ether, BN, expectRevert, expectEvent, constants, time, balance, send } = require('@openzeppelin/test-helpers');
const JoltifyCoin = artifacts.require('JoltifyCoin')
const Staking = artifacts.require('Staking')

contract('Staking', accounts=>{
  const [owner, user1, user2, LPRewardAddress] = accounts
  const YEAR = new BN(31536000) // in seconds
  const DAY = new BN(24*3600)
  const MAX_EMISSION_RATE = ether('0.15') // 15%
  const PARAM_UPDATE_DELAY = DAY.mul(new BN(7)) // 7 days in seconds
  const forcedWithdrawalFee = ether('0.03')
  const withdrawalLockDuration = DAY.mul(new BN(2))
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

  describe('PARAM_UPDATE_DELAY', async ()=>{
    // LPRewardAddress/forcedWithdrawalFee/withdrawalLockDuration
    beforeEach(async ()=>{
      await initialize(initializeParams)
    })
    it('Should not change before PARAM_UPDATE_DELAY reached and change after reached', async ()=>{
      const resLP = await staking.setLPRewardAddress(user2)
      expectEvent(resLP, 'LPRewardAddressSet', {value: user2, sender: owner})
      assert(user2!==(await staking.LPRewardAddress()))
      await time.increase(PARAM_UPDATE_DELAY)
      assert(user2===(await staking.LPRewardAddress()))

      const oneBN = new BN(1)

      const resForce = await staking.setForcedWithdrawalFee(oneBN)
      expectEvent(resForce, 'ForcedWithdrawalFeeSet', {value: new BN(1), sender: owner})
      assert(!oneBN.eq(await staking.forcedWithdrawalFee()))
      await time.increase(PARAM_UPDATE_DELAY)
      assert(oneBN.eq(await staking.forcedWithdrawalFee()))

      const resLock = await staking.setWithdrawalLockDuration(oneBN)
      expectEvent(resLock, 'WithdrawalLockDurationSet', {value: new BN(1), sender: owner})
      assert(!oneBN.eq(await staking.withdrawalLockDuration()))
      await time.increase(PARAM_UPDATE_DELAY)
      assert(oneBN.eq(await staking.withdrawalLockDuration()))
    })
  })

  describe('deposit', ()=>{
    beforeEach(async ()=>{
      await initialize(initializeParams)
    })
    it('Should deposit and emission properly', async ()=>{
      assert( (await staking.balances(user1)).eq(new BN(0)) ) // before deposit, balance in staking should be 0
      const res1 = await staking.deposit(oneEther, {from: user1})
      assert(oneEther.eq(await token.balanceOf(staking.address)))
      assert( (await staking.balances(user1)).eq(oneEther) ) // first time deposit
      expectEvent(res1, 'Deposited', {
        sender: user1,
        amount: oneEther,
        balance: oneEther,
        accruedEmission: new BN(0),
        prevDepositDuration: new BN(0)
      })
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
      assert(oneEther.add(oneEther).add(accruedEmission.userShare).eq(await token.balanceOf(staking.address)))
      assert(accruedEmission.total.sub(accruedEmission.userShare).eq(await token.balanceOf(LPRewardAddress)))
      expectEvent(res2, 'Deposited', {
        prevDepositDuration: timePassed, // passed
        sender: user1, // passed
        amount: oneEther, // passed
        accruedEmission: accruedEmission.userShare, // need cauculate
        balance: oneEther.mul(new BN(2)).add(accruedEmission.userShare) // emission should be included
      })
    })
  })

  describe('withdraw', async ()=>{
    let startTime
    beforeEach(async ()=>{
      await initialize(initializeParams)
      startTime = await staking.startTime()
    })
    it('Should minus fee if lockDuration not reached and 0 fee if lockDuration reached and emission is correct', async ()=>{
      const APRParams = await staking.APR()
      const totalSupplyFactorParams = await staking.totalSupplyFactor()
      
      await staking.deposit(oneEther.mul(new BN(2)), {from: user1})
      // console.log('token.balanceOf(staking.address)', (await token.balanceOf(staking.address)).toString()); return
      assert(oneEther.mul(new BN(2)).eq(await token.balanceOf(staking.address)))
      const depositDate1 = await staking.depositDates(user1)
      const totalSupply1 = await token.totalSupply()
      const totalStaked1 = await staking.totalStaked()
      const LPbalance1 = await token.balanceOf(LPRewardAddress)
      await time.increase( (await staking.withdrawalLockDuration()).div(new BN(2)) )
      const resWithdraw = await staking.withdraw(oneEther, {from: user1})
      assert(oneEther.eq(await token.balanceOf(staking.address)))
      const LPbalance2 = await token.balanceOf(LPRewardAddress)
      const withdrawDate = await getBlockTimestamp(resWithdraw)
      const depositDuration = withdrawDate.sub(depositDate1)
      const accruedEmission = getAccruedEmissions(
        withdrawDate, startTime, totalSupply1, totalStaked1, 
        depositDuration, APRParams, totalSupplyFactorParams
      )
      const fee = oneEther.add(accruedEmission.userShare).mul(await staking.forcedWithdrawalFee()).div(oneEther)
      assert(LPbalance2.eq(accruedEmission.total.sub(accruedEmission.userShare).add(fee)))
      expectEvent(resWithdraw, 'Withdrawn', {
        sender: user1,
        amount: oneEther.add(accruedEmission.userShare).sub(fee),
        lastDepositDuration: withdrawDate.sub(depositDate1),
        fee: fee,
        balance: oneEther,
        accruedEmission: accruedEmission.userShare
      })

      const depositDate2 = await staking.depositDates(user1)
      const totalSupply2 = await token.totalSupply()
      const totalStaked2 = await staking.totalStaked()
      await time.increase( (await staking.withdrawalLockDuration()).div(new BN(2)) )
      const resWithdraw2 = await staking.withdraw(oneEther, {from: user1})
      assert((new BN(0)).eq(await token.balanceOf(staking.address)))
      const LPbalance3 = await token.balanceOf(LPRewardAddress)
      const withdrawDate2 = await getBlockTimestamp(resWithdraw2)
      const depositDuration2 = withdrawDate2.sub(depositDate2)
      const accruedEmission2 = getAccruedEmissions(
        withdrawDate2, startTime, totalSupply2, totalStaked2, 
        depositDuration2, APRParams, totalSupplyFactorParams
      )
      assert(LPbalance3.eq(LPbalance2.add(accruedEmission2.total).sub(accruedEmission2.userShare)))
      const amount = oneEther.add(accruedEmission2.userShare)
      expectEvent(resWithdraw2, 'Withdrawn', {
        sender: user1,
        amount: amount,
        lastDepositDuration: depositDuration2,
        fee: new BN(0),
        balance: new BN(0),
        accruedEmission: accruedEmission2.userShare
      })
    })
  })

  function getAccruedEmissions(
    blockTime, startTime, totalSupply, totalStaked, 
    depositDuration, APRParams, totalSupplyFactorParams
  ) {
    const APR = getLinearDesc(blockTime.sub(startTime), APRParams)
    const totalSupplyFactor = getLinearDesc(blockTime.sub(startTime), totalSupplyFactorParams)
    const supplyBasedEmissionRate = getSupplyBasedEmissionRate(totalSupply, totalSupplyFactor, totalStaked)  
    const userEmissionRate = APR.add(supplyBasedEmissionRate)
    return getAccruedEmission(depositDuration, userEmissionRate, oneEther)
  }

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

  function initialize(param) {
    return staking.initialize(...param, {gas: 3000000})
  }

  async function getBlockTimestamp(receipt) {
    return new BN((await web3.eth.getBlock(receipt.receipt.blockNumber)).timestamp);
  }

  describe('initialize', ()=>{
    it('Should be set up correctly', async () => {
      await initialize(initializeParams)
      assert(token.address===await staking.token())
      assert(forcedWithdrawalFee.eq(await staking.forcedWithdrawalFee()))
      assert(withdrawalLockDuration.eq(await staking.withdrawalLockDuration()))
      assert(LPRewardAddress===(await staking.LPRewardAddress()))
      const APR = await staking.APR()
      assert(APRInitVal.eq(APR.initVal))
      assert(APRMinVal.eq(APR.minVal))
      assert(APRDescMonthly.eq(APR.descMonthly))
      const totalSupplyFactor = await staking.totalSupplyFactor()
      assert(totalSupplyFactorInitVal.eq(totalSupplyFactor.initVal))
      assert(totalSupplyFactorMinVal.eq(totalSupplyFactor.minVal))
      assert(totalSupplyFactorDescMonthly.eq(totalSupplyFactor.descMonthly))
      await expectRevert(initialize(initializeParams), 'Initializable: contract is already initialized')
    })
    it('Shold reject if tokenAddress is not a contract', async () => {
      initializeParams[0] = user2 // not a contract
      await expectRevert(initialize(initializeParams), 'not a contract address')
    })
    it('Should reject if setForcedWithdrawalFee bigger than 1 ether', async ()=>{
      initializeParams[1] = oneEther.add(new BN(1))
      await expectRevert(initialize(initializeParams), 'should be less than or equal to 1 ether')
    })
    it('Should reject if withdrawalLockDuration more than 30 days', async ()=>{
      initializeParams[2] = 30*24*3600+1
      await expectRevert(initialize(initializeParams), "shouldn't be greater than 30 days")
    })
    it('Should reject if LPRewardAddress is a 0 address', async ()=>{
      initializeParams[3] = constants.ZERO_ADDRESS
      await expectRevert(initialize(initializeParams), 'zero address')
    })
    it('Should reject if LPRewardAddress is staking address', async ()=>{
      initializeParams[3] = staking.address
      await expectRevert(initialize(initializeParams), 'wrong address')
    })
    it('Should reject if APR > MAX_EMISSION_RATE/2', async ()=>{
      initializeParams[4] = MAX_EMISSION_RATE.div(new BN(2)).add(new BN(1))
      await expectRevert(initialize(initializeParams), '_APRInitVal>MAX_EMISSION_RATE/2 is not allowed')
    })
    it('Should reject if TotalSupplyFactor bigger than 1 ether', async ()=>{
      initializeParams[7] = oneEther.add(new BN(1))
      await expectRevert(initialize(initializeParams), 'should be less than or equal to 1 ether')
    })
  })
})
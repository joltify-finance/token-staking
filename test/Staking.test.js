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
  const basicAPR = ether('0.075')
  const totalSupplyFactor = ether('1')
  const monthlyDescRate = ether('0.01')
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
      totalSupplyFactor,
      basicAPR,
      monthlyDescRate
    ]
  })

  function getAccruedEmission(timePassed, userEmissionRate, amount) {
    if (timePassed.eq(new BN(0)) || amount.eq(new BN(0))) {
      return {total: new BN(0), userShare: new BN(0)}
    }
    const userShare = amount.mul(userEmissionRate ).mul(timePassed).div(YEAR.mul(oneEther))
    let total = amount.mul(MAX_EMISSION_RATE).mul(timePassed).div(YEAR.mul(oneEther))
    if (userShare.eq(new BN(0))) {
      total = new BN(0)
    }
    return {total: total, userShare: userShare}
  }

  function userEmissionRate(basicAPR, supplyBasedEmissionRate, blockTime, startTime, monthlyDescRate) {
      let _userEmissionRate = basicAPR.add(supplyBasedEmissionRate)
      const descRate = (blockTime.sub(startTime)).mul(monthlyDescRate).div(DAY.mul(new BN(30)))
      // console.log('descRate', descRate.toString())
      if (descRate.gte(oneEther)) {
        return new BN(0)
      }
      // console.log('oneEther.sub(descRate)', oneEther.sub(descRate).toString() )
      const returnData = _userEmissionRate.mul( oneEther.sub(descRate) ).div(oneEther)
      // console.log('returnData', returnData)
      return returnData
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
  
  describe('Withdraw', async ()=>{
    let startTime
    beforeEach(async ()=>{
      await initialize(initializeParams)
      startTime = await staking.startTime()
    })
    it('Should minus fee if lockDuration not reached and 0 fee if lockDuration reached and emission is correct', async ()=>{
      const totalSupplyFactor = await staking.totalSupplyFactor()
      const monthlyDescRate = await staking.monthlyDescRate()
      const receipt = await staking.deposit(oneEther.mul(new BN(2)), {from: user1})
      // console.log('token.balanceOf(staking.address)', (await token.balanceOf(staking.address)).toString()); return
      assert(oneEther.mul(new BN(2)).eq(await token.balanceOf(staking.address)))
      const depositDate1 = await staking.depositDates(user1)
      const totalSupply1 = await token.totalSupply()
      const totalStaked1 = await staking.totalStaked()
      const LPbalance1 = await token.balanceOf(LPRewardAddress)
      await time.increase( (await staking.withdrawalLockDuration()).div(new BN(2)) )
      const timeBefore = getBlockTimestamp(receipt)
      const resWithdraw = await staking.withdraw(oneEther, {from: user1})
      assert(oneEther.eq(await token.balanceOf(staking.address)))
      const LPbalance2 = await token.balanceOf(LPRewardAddress)
      const withdrawDate = await getBlockTimestamp(resWithdraw)
      const depositDuration = withdrawDate.sub(depositDate1)
      const supplyBasedEmissionRate = getSupplyBasedEmissionRate(totalSupply1, totalSupplyFactor, totalStaked1)
      const _userEmissionRate = userEmissionRate(basicAPR, supplyBasedEmissionRate, withdrawDate, startTime, monthlyDescRate)
      const accruedEmission = getAccruedEmission(depositDuration, _userEmissionRate, oneEther)
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
      const timeBefore2 = await getBlockTimestamp(resWithdraw2)
      assert((new BN(0)).eq(await token.balanceOf(staking.address)))
      const LPbalance3 = await token.balanceOf(LPRewardAddress)
      const withdrawDate2 = await getBlockTimestamp(resWithdraw2)
      const depositDuration2 = withdrawDate2.sub(depositDate2)
      const supplyBasedEmissionRate2 = getSupplyBasedEmissionRate(totalSupply2, totalSupplyFactor, totalStaked2)
      const _userEmissionRate2 = userEmissionRate(basicAPR, supplyBasedEmissionRate2, timeBefore2, startTime, monthlyDescRate)
      const accruedEmission2 = getAccruedEmission(depositDuration2, _userEmissionRate2, oneEther)
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

      await time.increase(YEAR.mul(new BN(10)))
      // withdraw again, test if userEmission is 0
    })
  })

  describe('Deposit', ()=>{
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

      const startTime = await staking.startTime()
      const monthlyDescRate = await staking.monthlyDescRate()
      // console.log('monthlyDescRate', monthlyDescRate.toString()); return
      const totalSupplyFactor = await staking.totalSupplyFactor()
      const basicAPR = await staking.basicAPR()
      // console.log('basicAPR', basicAPR.toString()); return

      const timeBefore = await getBlockTimestamp(res1)
      await time.increase(DAY.mul(new BN(2)))
      
      const totalStakedBefore = await staking.totalStaked()
      const totalSupplyBefore = await token.totalSupply()
      const depositTime1 = await staking.depositDates(user1)
      const balanceBefore = await staking.balances(user1)

      const res2 = await staking.deposit(oneEther, {from: user1})

      const blocktimeDeposit2 = await getBlockTimestamp(res2)
      const timePassed = blocktimeDeposit2.sub(depositTime1)
      // console.log('timePassed', timePassed.toString()); return
      
      const supplyBasedEmissionRate = getSupplyBasedEmissionRate(totalSupplyBefore, totalSupplyFactor, totalStakedBefore)
      // console.log('supplyBasedEmissionRate', supplyBasedEmissionRate.toString()); return

      const _userEmissionRate = userEmissionRate(basicAPR, supplyBasedEmissionRate, blocktimeDeposit2, startTime, monthlyDescRate)
      // console.log('_userEmissionRate', _userEmissionRate.toString()); return

      const accruedEmission = getAccruedEmission(timePassed, _userEmissionRate, balanceBefore)

      // console.log(oneEther.add(oneEther).add(accruedEmission.userShare).toString(), (await token.balanceOf(staking.address)).toString() )

      assert(oneEther.add(oneEther).add(accruedEmission.userShare).eq(await token.balanceOf(staking.address)))
      assert(accruedEmission.total.sub(accruedEmission.userShare).eq(await token.balanceOf(LPRewardAddress)))
      expectEvent(res2, 'Deposited', {
        prevDepositDuration: timePassed, // passed
        sender: user1, // passed
        amount: oneEther, // passed
        accruedEmission: accruedEmission.userShare, // need cauculate
        balance: oneEther.mul(new BN(2)).add(accruedEmission.userShare) // emission should be included
      })


      await time.increase(YEAR.mul(new BN(10)))
      // deposit againt, test if userEmission is 0
    })
  })

  describe('PARAM_UPDATE_DELAY', async ()=>{
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
      expectEvent(resForce, 'ForcedWithdrawalFeeSet', {value: oneBN, sender: owner})
      assert(!oneBN.eq(await staking.forcedWithdrawalFee()))
      await time.increase(PARAM_UPDATE_DELAY)
      assert(oneBN.eq(await staking.forcedWithdrawalFee()))

      const resLock = await staking.setWithdrawalLockDuration(oneBN)
      expectEvent(resLock, 'WithdrawalLockDurationSet', {value: oneBN, sender: owner})
      assert(!oneBN.eq(await staking.withdrawalLockDuration()))
      await time.increase(PARAM_UPDATE_DELAY)
      assert(oneBN.eq(await staking.withdrawalLockDuration()))

      const resFactor = await staking.setTotalSupplyFactor(oneBN)
      expectEvent(resFactor, 'TotalSupplyFactorSet', {value: oneBN, sender: owner})
      assert(!oneBN.eq(await staking.totalSupplyFactor()))
      await time.increase(PARAM_UPDATE_DELAY)
      assert(oneBN.eq(await staking.totalSupplyFactor()))

      const resBasic = await staking.setBasicAPR(oneBN)
      expectEvent(resBasic, 'BasicAPRSet', {value: new BN(1), sender: owner})
      assert(!oneBN.eq(await staking.basicAPR()))
      await time.increase(PARAM_UPDATE_DELAY)
      assert(oneBN.eq(await staking.basicAPR()))

      const resMonthly = await staking.setMonthlyDescRate(oneBN)
      expectEvent(resMonthly, 'MonthlyDescRateSet', {value: new BN(1), sender: owner})
      assert(!oneBN.eq(await staking.monthlyDescRate()))
      await time.increase(PARAM_UPDATE_DELAY)
      assert(oneBN.eq(await staking.monthlyDescRate()))
    })
  })

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
      assert(totalSupplyFactor.eq(await staking.totalSupplyFactor()))
      assert(basicAPR.eq(await staking.basicAPR()))
      assert(monthlyDescRate.eq(await staking.monthlyDescRate()))
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
    it('Should reject if totalSupplyFactor bigger than 1 ether', async ()=>{
      initializeParams[4] = oneEther.add(new BN(1))
      await expectRevert(initialize(initializeParams), 'should be less than or equal to 1 ether')
    })
    it('Should reject if basicAPR bigger than half MAX_EMISSION_RATE', async ()=>{
      initializeParams[5] = MAX_EMISSION_RATE.div(new BN(2)).add(new BN(1))
      await expectRevert(initialize(initializeParams), 'should be less than or equal to half MAX_EMISSION_RATE')
    })
  })
})
const { ether, BN, expectRevert, expectEvent, constants, time, balance, send } = require('@openzeppelin/test-helpers');
const JoltifyCoin = artifacts.require('JoltifyCoin')
const Staking = artifacts.require('Staking')

contract('Staking', accounts=>{
  const [owner, user1, user2, LPRewardAddress] = accounts
  const YEAR = new BN(31536000) // in seconds
  const DAY = new BN(24*3600)
  const PARAM_UPDATE_DELAY = DAY.mul(new BN(7)) // 7 days in seconds
  const forcedWithdrawalFee = ether('0.03')
  const withdrawalLockDuration = DAY.mul(new BN(2))
  const oneEther = ether('1')
  const basicAPR = ether('1.5') // 150%
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
      basicAPR
    ]
  })

  async function getAccruedEmission(_depositDate, _amount, currentTime) {
    let total, userShare, timePassed = 0
    if (0==_depositDate || 0==_amount) {
      return {total: total, userShare: userShare, timePassed: timePassed}
    }
    const APRHistories = await getAPRHistories()
    timePassed = currentTime.sub(_depositDate)

    let timePoints = []
    timePoints[0] = _depositDate
    let APRs = []
    APRs[0] = APRHistories[0].value
    for(let i=1; i<APRHistories.length; i++) {
      if (APRHistories[i].timestamp < currentTime) {
        if (APRHistories[i].timestamp>timePoints[timePoints.length-1]) {
          timePoints[timePoints.length] = APRHistories[i].timestamp
          APRs[APRs.length] = APRHistories[i].value
        } else {
          APRs[0] = APRHistories[i].value
        }
      }
    }
    timePoints[timePoints.length] = currentTime
    total = new BN(0)
    console.log('timePoints.length', timePoints.length)
    console.log('APRs.length', APRs.length)
    for (let j=0; j<timePoints.length-1; j++) {
      console.log(_amount.toString() + ' * (' + timePoints[j+1].toString() + ' - ' + timePoints[j].toString() + ') * ' + APRs[j].toString() )
      total = total.add( _amount.mul( timePoints[j+1].sub(timePoints[j]) ).mul(APRs[j]).div(YEAR).div(oneEther) )
    }
    userShare = total.mul(await staking.USER_SHARE_RATE({gas: 3000000})).div(oneEther)
    return {total: total, userShare: userShare, timePassed: timePassed}
  }

  async function getAPRHistories() {
    let histories = []
    let i = 0;
    while(true) {
      try {
        const history = await staking.APRHistories(i);
        histories.push({
          timestamp: history.timestamp,
          value: history.value
        })
        i++;
      } catch (e) {
        console.error(e.message)
        break
      }
    }
    return histories
  }

  describe('Manual emission calculation', async ()=>{
    // 4 situations: https://cdn.discordapp.com/attachments/907425201883582464/912599067543076914/IMG_20211123_150230.jpg

    it('Situation 1', async ()=>{
      const amount = oneEther
      const holdTime = YEAR // form deposit to withdraw
      initializeParams[4] = ether('1') // APR = 100%
      await initialize(initializeParams)
      const USER_SHARE_RATE = await staking.USER_SHARE_RATE()
      const APR1 = await staking.basicAPR()
      const depositTx = await staking.deposit(amount, {from: user1})
      const depositTime = await getBlockTimestamp(depositTx)
      await time.increase(holdTime)
      const balanceBeforeWithdraw = await token.balanceOf(user1)
      const withdrawTx = await staking.withdraw(amount, {from: user1})
      const withdrawTime = await getBlockTimestamp(withdrawTx)
      const interval1 = withdrawTime.sub(depositTime)
      console.log('time offset', interval1.sub(YEAR).toString()) // 3 or 4 seconds
      const userShareFromBlock = (await token.balanceOf(user1)).sub(balanceBeforeWithdraw).sub(amount)
      const userShareCalc = amount.mul(interval1).mul(APR1).mul(USER_SHARE_RATE).div(oneEther).div(oneEther).div(YEAR)
      console.log('userShareFromBlock', userShareFromBlock.toString(), 'userShareCalc', userShareCalc.toString())
      assert(userShareCalc.sub(userShareFromBlock).abs().lte(new BN(1)))
    })

    it('Situation 2', async ()=>{
      const amount = oneEther
      const holdTime = YEAR // form deposit to withdraw
      initializeParams[4] = ether('1') // APR = 100%
      await initialize(initializeParams)
      const USER_SHARE_RATE = await staking.USER_SHARE_RATE()

      await staking.setBasicAPR(oneEther.div(new BN(2))) // APR = 50%
      await time.increase(await staking.PARAM_UPDATE_DELAY())

      const APR1 = await staking.basicAPR()
      console.log('APR1', APR1.toString())
      
      const depositTx = await staking.deposit(amount, {from: user1})
      const depositTime = await getBlockTimestamp(depositTx)
      await time.increase(holdTime)
      const balanceBeforeWithdraw = await token.balanceOf(user1)
      const withdrawTx = await staking.withdraw(amount, {from: user1})
      const withdrawTime = await getBlockTimestamp(withdrawTx)
      const interval1 = withdrawTime.sub(depositTime)
      const userShareFromBlock = (await token.balanceOf(user1)).sub(balanceBeforeWithdraw).sub(amount)
      const userShareCalc = amount.mul(interval1).mul(APR1).mul(USER_SHARE_RATE).div(oneEther).div(oneEther).div(YEAR)
      console.log('userShareFromBlock', userShareFromBlock.toString(), 'userShareCalc', userShareCalc.toString())
      assert(userShareCalc.sub(userShareFromBlock).abs().lte(new BN(2)))
    })

    it('Situation 3', async ()=>{
      const amount = oneEther
      const delay1 = YEAR // from deposit to first APR setting
      const delay2 = YEAR // from first APR setting to withdraw
      initializeParams[4] = ether('1') // APR = 100%
      await initialize(initializeParams)
      const USER_SHARE_RATE = await staking.USER_SHARE_RATE()
      const PARAM_UPDATE_DELAY = await staking.PARAM_UPDATE_DELAY()

      const depositTx = await staking.deposit(amount, {from: user1})
      const depositTime = await getBlockTimestamp(depositTx)

      const APR1 = await staking.basicAPR()
      console.log('APR1', APR1.toString())

      await time.increase(delay1)
      const APRSetTx = await staking.setBasicAPR(oneEther.div(new BN(2))) // APR = 50%
      const APRSetTime = await getBlockTimestamp(APRSetTx)
      const interval1 = APRSetTime.add(PARAM_UPDATE_DELAY).sub(depositTime)
      await time.increase(PARAM_UPDATE_DELAY)

      const APR2 = await staking.basicAPR()
      console.log('APR2', APR2.toString())

      await time.increase(delay2)

      const balanceBeforeWithdraw = await token.balanceOf(user1)
      const withdrawTx = await staking.withdraw(amount, {from: user1})
      const withdrawTime = await getBlockTimestamp(withdrawTx)
      const interval2 = withdrawTime.sub(APRSetTime.add(PARAM_UPDATE_DELAY))

      const userShareFromBlock = (await token.balanceOf(user1)).sub(balanceBeforeWithdraw).sub(amount)

      const userShareCalc = amount.mul(interval1).mul(APR1).mul(USER_SHARE_RATE).div(oneEther).div(oneEther).div(YEAR)
                       .add(amount.mul(interval2).mul(APR2).mul(USER_SHARE_RATE).div(oneEther).div(oneEther).div(YEAR))

      console.log('userShareFromBlock', userShareFromBlock.toString(), 'userShareCalc', userShareCalc.toString())
      assert(userShareCalc.sub(userShareFromBlock).abs().lte(new BN(3)))
    })

    it('Situation 4', async ()=>{
      const amount = oneEther
      const delay1 = YEAR // from deposit to second APR setting
      const delay2 = YEAR // from second APR set to third APR set
      const delay3 = YEAR // form withdraw to third APR set
      initializeParams[4] = ether('1.5') // APR = 150%
      await initialize(initializeParams)
      const USER_SHARE_RATE = await staking.USER_SHARE_RATE()
      const PARAM_UPDATE_DELAY = await staking.PARAM_UPDATE_DELAY()

      await staking.setBasicAPR(oneEther) // APR = 100%
      await time.increase(PARAM_UPDATE_DELAY)

      const depositTx = await staking.deposit(amount, {from: user1})
      const depositTime = await getBlockTimestamp(depositTx)

      const APR1 = await staking.basicAPR()
      console.log('APR1', APR1.toString())

      await time.increase(delay1)

      const APRSetTx1 = await staking.setBasicAPR(oneEther.div(new BN(2))) // APR = 50%
      await time.increase(PARAM_UPDATE_DELAY)
      const APR2 = await staking.basicAPR()
      console.log('APR2', APR2.toString())
      const APRSetTime1 = (await getBlockTimestamp(APRSetTx1)).add(PARAM_UPDATE_DELAY)
      const interval1 = APRSetTime1.sub(depositTime)
      
      await time.increase(delay2)

      const APRSetTx2 = await staking.setBasicAPR(oneEther.div(new BN(4))) // APR = 25%
      await time.increase(PARAM_UPDATE_DELAY)
      const APRSetTime2 = (await getBlockTimestamp(APRSetTx2)).add(PARAM_UPDATE_DELAY)
      const APR3 = await staking.basicAPR()
      console.log('APR3', APR3.toString())
      const interval2 = APRSetTime2.sub(APRSetTime1)

      await time.increase(delay3)

      const balanceBeforeWithdraw = await token.balanceOf(user1)
      const withdrawTx = await staking.withdraw(amount, {from: user1})
      const withdrawTime = await getBlockTimestamp(withdrawTx)
      const interval3 = withdrawTime.sub(APRSetTime2)

      const userShareFromBlock = (await token.balanceOf(user1)).sub(balanceBeforeWithdraw).sub(amount)
      const userShareCalc = amount.mul(interval1).mul(APR1).mul(USER_SHARE_RATE).div(oneEther).div(oneEther).div(YEAR)
                       .add(amount.mul(interval2).mul(APR2).mul(USER_SHARE_RATE).div(oneEther).div(oneEther).div(YEAR))
                       .add(amount.mul(interval3).mul(APR3).mul(USER_SHARE_RATE).div(oneEther).div(oneEther).div(YEAR))

      console.log('userShareFromBlock', userShareFromBlock.toString(), 'userShareCalc', userShareCalc.toString())
      assert(userShareCalc.sub(userShareFromBlock).abs().lte(new BN(4)))
      
    })

    it('Situation 5', async ()=>{
      const amount = oneEther
      const delay1 = YEAR // from deposit to second APR setting
      const delay2 = YEAR // from second APR set to third APR set
      const delay3 = YEAR // 
      const delay4 = YEAR
      initializeParams[4] = ether('1.5') // APR = 150%
      await initialize(initializeParams)
      const USER_SHARE_RATE = await staking.USER_SHARE_RATE()
      const PARAM_UPDATE_DELAY = await staking.PARAM_UPDATE_DELAY()

      await staking.setBasicAPR(oneEther) // APR = 100%
      await time.increase(PARAM_UPDATE_DELAY)

      const depositTx = await staking.deposit(amount, {from: user1})
      const depositTime = await getBlockTimestamp(depositTx)

      const APR1 = await staking.basicAPR()
      console.log('APR1', APR1.toString())

      await time.increase(delay1)

      const APRSetTx1 = await staking.setBasicAPR(oneEther.div(new BN(2))) // APR = 50%
      await time.increase(PARAM_UPDATE_DELAY)
      const APR2 = await staking.basicAPR()
      console.log('APR2', APR2.toString())
      const APRSetTime1 = (await getBlockTimestamp(APRSetTx1)).add(PARAM_UPDATE_DELAY)
      const interval1 = APRSetTime1.sub(depositTime)
      
      await time.increase(delay2)

      const APRSetTx2 = await staking.setBasicAPR(oneEther.div(new BN(4))) // APR = 25%
      await time.increase(PARAM_UPDATE_DELAY)
      const APRSetTime2 = (await getBlockTimestamp(APRSetTx2)).add(PARAM_UPDATE_DELAY)
      const APR3 = await staking.basicAPR()
      console.log('APR3', APR3.toString())
      const interval2 = APRSetTime2.sub(APRSetTime1)

      await time.increase(delay3)

      const APRSetTx3 = await staking.setBasicAPR(oneEther.div(new BN(5))) // APR = 20%
      await time.increase(PARAM_UPDATE_DELAY)
      const APRSetTime3 = (await getBlockTimestamp(APRSetTx3)).add(PARAM_UPDATE_DELAY)
      const APR4 = await staking.basicAPR()
      console.log('APR4', APR4.toString())
      const interval3 = APRSetTime3.sub(APRSetTime2)

      await time.increase(delay4)

      const balanceBeforeWithdraw = await token.balanceOf(user1)
      const withdrawTx = await staking.withdraw(amount, {from: user1})
      const withdrawTime = await getBlockTimestamp(withdrawTx)
      const interval4 = withdrawTime.sub(APRSetTime3)

      const userShareFromBlock = (await token.balanceOf(user1)).sub(balanceBeforeWithdraw).sub(amount)
      const userShareCalc = amount.mul(interval1).mul(APR1).mul(USER_SHARE_RATE).div(oneEther).div(oneEther).div(YEAR)
                       .add(amount.mul(interval2).mul(APR2).mul(USER_SHARE_RATE).div(oneEther).div(oneEther).div(YEAR))
                       .add(amount.mul(interval3).mul(APR3).mul(USER_SHARE_RATE).div(oneEther).div(oneEther).div(YEAR))
                       .add(amount.mul(interval4).mul(APR4).mul(USER_SHARE_RATE).div(oneEther).div(oneEther).div(YEAR))

      console.log('userShareFromBlock', userShareFromBlock.toString(), 'userShareCalc', userShareCalc.toString())
      assert(userShareCalc.sub(userShareFromBlock).abs().lte(new BN(5)))
      
    })

  })

  describe('Emission', async ()=>{
    beforeEach(async ()=>{ // must use (), not "_" after async
      await initialize(initializeParams)
    })
    
    it('APR is not 0 at first, after deposit for some time, change to 0, emission must be the same at anytime withdraw after setting APY to 0', async ()=>{
      // deposit 2 eterh at first
      const depositRes = await staking.deposit(oneEther.mul(new BN(2)), {from: user1})
      const depositTime = await getBlockTimestamp(depositRes)

      // set APR to 0
      await staking.setBasicAPR(0);
      // wait for new APR update
      await time.increase( await staking.PARAM_UPDATE_DELAY() )
      console.log('APR2', (await staking.basicAPR()).toString()) // 0
      // await time.increase( 24*3600*7 )
      
      // now APR is 0, withdraw 1 ether and record the emission1
      const balanceBeforeWithdraw1 = await token.balanceOf(user1)
      const LPBalanceBeforeWithdraw1 = await token.balanceOf(LPRewardAddress)

      const withdrawTx1 = await staking.withdraw(oneEther, {from: user1, gas: 3000000})

      const withdrawTime1 = await getBlockTimestamp(withdrawTx1)
      const userShare1 = (await token.balanceOf(user1)).sub(balanceBeforeWithdraw1)
      const LPShare1 = (await token.balanceOf(LPRewardAddress)).sub(LPBalanceBeforeWithdraw1)
      const emission1 = await getAccruedEmission(depositTime, oneEther, withdrawTime1)
      console.log('emission1.userShare', emission1.userShare.toString());
      console.log('userShare1.toString()', userShare1.toString())

      
      // long time passed
      await time.increase( DAY.mul(new BN(300)) )

      // withdraw again and record the emission2
      const balanceBeforeWithdraw2 = await token.balanceOf(user1)
      const LPBalanceBeforeWithdraw2 = await token.balanceOf(LPRewardAddress)

      const withdrawTx2 = await staking.withdraw(oneEther, {from: user1})

      const withdrawTime2 = await getBlockTimestamp(withdrawTx2)
      const userShare2 = (await token.balanceOf(user1)).sub(balanceBeforeWithdraw2)
      const LPShare2 = (await token.balanceOf(LPRewardAddress)).sub(LPBalanceBeforeWithdraw2)
      const emission2 = await getAccruedEmission(depositTime, oneEther, withdrawTime2)
      console.log('emission2.userShare', emission2.userShare.toString());
      // after APR is 0, the emission should be the same even long time passed
      console.log('userShare2.toString()', userShare2.toString())
      // console.log(LPShare1.toString(), LPShare2.toString())
      assert(userShare1.eq(userShare2))
      assert(LPShare1.eq(LPShare2))
    })

    it('APR is 0, emission will also be 0', async ()=>{
      await staking.setBasicAPR(0);
      await time.increase( await staking.PARAM_UPDATE_DELAY() )
      // console.log('APR', (await staking.basicAPR()).toString()); return
      const depositRes = await staking.deposit(oneEther, {from: user1})
      const depositTime = await getBlockTimestamp(depositRes)
      await time.increase( (await staking.withdrawalLockDuration()).mul(new BN(2)) )
      // console.log('balance in staking', (await staking.balances(user1)).toString() ); return
      const withdrawRes = await staking.withdraw(oneEther, {from: user1, gas: 3000000})
      // console.log('balance in staking', (await staking.balances(user1)).toString() ); return
      const withdrawTime = await getBlockTimestamp(withdrawRes)
      // console.log(depositTime.toString(), oneEther.toString(), withdrawTime.toString()); return
      const accruedEmission = await getAccruedEmission(depositTime, oneEther, withdrawTime)
      assert(accruedEmission.total.eq(new BN(0)) && accruedEmission.userShare.eq(new BN(0)))
      assert((new BN(0)).eq(await token.balanceOf(LPRewardAddress))) // no emission to reward
    })
  })
  
  describe('Withdraw', async ()=>{
    beforeEach(async ()=>{ // must use (), not "_" after async
      await initialize(initializeParams)
    })
    it('Should minus fee if lockDuration not reached and 0 fee if lockDuration reached and emission is correct', async ()=>{
      const receipt = await staking.deposit(oneEther.mul(new BN(2)), {from: user1})
      assert(oneEther.mul(new BN(2)).eq(await token.balanceOf(staking.address)))
      const depositDate1 = await staking.depositDates(user1)
      await time.increase( (await staking.withdrawalLockDuration()).div(new BN(2)) ) // half of FORCED_WITHDRAWAL_DURATION
      const timeBefore = await getBlockTimestamp(receipt)
      const resWithdraw = await staking.withdraw(oneEther, {from: user1})
      assert(oneEther.eq(await token.balanceOf(staking.address)))
      const LPbalance2 = await token.balanceOf(LPRewardAddress)
      const withdrawDate = await getBlockTimestamp(resWithdraw)
      
      const accruedEmission = await getAccruedEmission(timeBefore, oneEther, withdrawDate)
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
      const accruedEmission2 = await getAccruedEmission(depositDate2, oneEther, withdrawDate2)
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

  describe('initialize', ()=>{
    it('Should be set up correctly', async () => {
      await initialize(initializeParams)
      assert(token.address===await staking.token())
      assert(forcedWithdrawalFee.eq(await staking.forcedWithdrawalFee()))
      assert(withdrawalLockDuration.eq(await staking.withdrawalLockDuration()))
      assert(LPRewardAddress===(await staking.LPRewardAddress()))
      assert(basicAPR.eq(await staking.basicAPR()))
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

      const resBasic = await staking.setBasicAPR(oneBN)
      expectEvent(resBasic, 'BasicAPRSet', {value: new BN(1), sender: owner})
      assert(!oneBN.eq(await staking.basicAPR()))
      await time.increase(PARAM_UPDATE_DELAY)
      assert(oneBN.eq(await staking.basicAPR()))
    })
  })

  describe('Deposit', async ()=>{
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

      await time.increase(DAY.mul(new BN(2)))
      const depositTime1 = await staking.depositDates(user1)
      const res2 = await staking.deposit(oneEther, {from: user1})
      const blocktimeDeposit2 = await getBlockTimestamp(res2)
      const timePassed = blocktimeDeposit2.sub(depositTime1)

      const accruedEmission = await getAccruedEmission(depositTime1, oneEther, blocktimeDeposit2)

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

  function initialize(param) {
    return staking.initialize(...param, {gas: 3000000})
  }

  async function getBlockTimestamp(receipt) {
    return new BN((await web3.eth.getBlock(receipt.receipt.blockNumber)).timestamp);
  }
})
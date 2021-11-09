// https://testnet.bscscan.com/address/0xF69c9a17580e149DdB24cb2D240e3774FFACfeC8#writeContract
const {
  BN,           // Big Number support
  constants,    // Common constants, like the zero address and largest integers
  expectEvent,  // Assertions for emitted events
  expectRevert, // Assertions for transactions that should fail
} = require('@openzeppelin/test-helpers')
const { web3 } = require('@openzeppelin/test-helpers/src/setup')

const JoltifyCoin = artifacts.require('JoltifyCoin')
const Staking = artifacts.require('Staking')
describe('Jolt staking test', _=>{

  it('Before test preparing', async ()=>{
    // console.log(typeof web3.utils.toWei('75', 'finney'), web3.utils.toWei('75', 'finney')); return; // string 75000000000000000
    // console.log(new BN(web3.utils.toWei('1')).add(new BN(1)).toString()); return // 1000000000000000001
    this.token = await JoltifyCoin.new()
    // console.log(await this.token); return
    this.staking = await Staking.new()
    this.accounts = await web3.eth.getAccounts() // 0: admin, 1-2: for testing, 3: as LPRewardAddress tester
    const mintAmount = new BN(web3.utils.toWei('1000000'))
    await this.token.mint(this.accounts[1], mintAmount)
    await this.token.mint(this.accounts[2], mintAmount)
    await this.token.approve(this.staking.address, mintAmount.mul(new BN(2)), {from: this.accounts[1]})
    await this.token.approve(this.staking.address, mintAmount.mul(new BN(2)), {from: this.accounts[2]})
    this.maxEmissionRate = await this.staking.maxEmissionRate()
    await this.token.grantRole(await this.token.MINTER_ROLE(), this.staking.address) // add token minter
  }).timeout(10000)
  // return // code below will not run

  it('Should initialize staking properly', async ()=>{
    const init = {
      token: this.token.address,
      forcedWithdrawalFee: new BN(web3.utils.toWei('50', 'finney')), // 1 finney = 1/1000 ether
      withdrawalLockDuration: new BN(1), // seconds
      LPRewardAddress: this.accounts[3],
      APRInitVal: new BN(web3.utils.toWei('75', 'finney')),
      APRMinVal: new BN(web3.utils.toWei('5', 'finney')),
      APRDescMonthly: new BN(web3.utils.toWei('5', 'finney')),
      totalSupplyFactorInitVal: new BN(web3.utils.toWei('50', 'finney')),
      totalSupplyFactorMinVal: new BN(web3.utils.toWei('5', 'finney')),
      totalSupplyFactorDescMonthly: new BN(web3.utils.toWei('5', 'finney')),
      updateDelayTime: new BN(1)
    }

    await this.staking.initialize(
      init.token, // token address
      init.forcedWithdrawalFee, //_forcedWithdrawalFee, 1 finney = 1/1000 ether
      init.withdrawalLockDuration, // _withdrawalLockDuration
      init.LPRewardAddress, // _LPRewardAddress
      init.APRInitVal, // _APRInitVal
      init.APRMinVal, // _APRMinVal
      init.APRDescMonthly, // _APRDescMonthly
      init.totalSupplyFactorInitVal, // _totalSupplyFactorInitVal
      init.totalSupplyFactorMinVal, // _totalSupplyFactorMinVal
      init.totalSupplyFactorDescMonthly, // _totalSupplyFactorDescMonthly
      init.updateDelayTime // _updateDelayTime
    )

    assert(init.token===await this.staking.token())
    assert(init.forcedWithdrawalFee.eq(await this.staking.forcedWithdrawalFee()))
    assert(init.withdrawalLockDuration.eq(await this.staking.withdrawalLockDuration()))
    assert(init.LPRewardAddress===await this.staking.LPRewardAddress())
    const APR = await this.staking.APR()
    assert(init.APRInitVal.eq(APR.initVal))
    assert(init.APRMinVal.eq(APR.minVal))
    assert(init.APRDescMonthly.eq(APR.descMonthly))
    const totalSupplyFactor = await this.staking.totalSupplyFactor()
    assert(init.totalSupplyFactorInitVal.eq(totalSupplyFactor.initVal))
    assert(init.totalSupplyFactorMinVal.eq(totalSupplyFactor.minVal))
    assert(init.totalSupplyFactorDescMonthly.eq(totalSupplyFactor.descMonthly))
    assert(init.updateDelayTime.eq(await this.staking.updateDelayTime()))
  }).timeout(20000)

  it('Should reject all if not owner call onlyOwner function', async ()=>{
    const sender = {from: this.accounts[1]} // not admin
    const intVal = new BN(1)
    const addressVal = this.accounts[9]
    try {
      await this.staking.setUpdateDelayTime(intVal, sender)
      assert(false)
    } catch(e) {
      assert(e.message.includes('Ownable: caller is not the owner'))
    }
    try {
      await this.staking.setWithdrawalLockDuration(intVal, sender)
      assert(false)
    } catch(e) {
      assert(e.message.includes('Ownable: caller is not the owner'))
    }
    try {
      await this.staking.setForcedWithdrawalFee(intVal, sender)
      assert(false)
    } catch(e) {
      assert(e.message.includes('Ownable: caller is not the owner'))
    }
    try {
      await this.staking.setLPRewardAddress(addressVal, sender)
      assert(false)
    } catch(e) {
      assert(e.message.includes('Ownable: caller is not the owner'))
    }
    try {
      await this.staking.setAPR(intVal, intVal, intVal, sender)
      assert(false)
    } catch(e) {
      assert(e.message.includes('Ownable: caller is not the owner'))
    }
  }).timeout(10000)

  it('Should setUpdateDelayTime properly', async ()=>{
    const oldUpdateDelayTime = await this.staking.updateDelayTime()
    const newUpdateDelayTime = new BN(3)
    assert(!oldUpdateDelayTime.eq(newUpdateDelayTime))
    await this.staking.setUpdateDelayTime(newUpdateDelayTime)
    assert( newUpdateDelayTime.eq(await this.staking.updateDelayTime()) )
  })

  it('Should setWithdrawalLockDuration properly', async ()=>{
    const duration = new BN(3)
    try {
      await this.staking.setWithdrawalLockDuration(31*24*3600+1)
      assert(false)
    } catch (e) {
      assert(e.message.includes("shouldn't be greater than 30 days"))
      await this.staking.setWithdrawalLockDuration(duration)
      assert(!duration.eq(await this.staking.withdrawalLockDuration()))
      // console.log(new Date().getTime(), (await web3.eth.getBlockNumber()))
      await sleep(Number(await this.staking.updateDelayTime())*1000)
      await this.staking.setUpdateDelayTime(new BN(3)) // to mint a new block
      assert(duration.eq(await this.staking.withdrawalLockDuration()))
      // console.log(new Date().getTime(), (await web3.eth.getBlockNumber()))
    }
  }).timeout(10000)

  it('Should setForcedWithdrawalFee properly', async ()=>{
    const forcedWithdrawalFee = new BN(web3.utils.toWei('100', 'finney')) // 100 finney = 0.1 ether = 10%
    try {
      await this.staking.setForcedWithdrawalFee( new BN(web3.utils.toWei('1')).add(new BN(1)) )
      assert(false)
    } catch (e) {
      assert(e.message.includes('should be less than or equal to 1 ether'))
      await this.staking.setForcedWithdrawalFee(forcedWithdrawalFee)
      assert(!forcedWithdrawalFee.eq(await this.staking.forcedWithdrawalFee()))
      await sleep(Number(await this.staking.updateDelayTime())*1000)
      await this.staking.setUpdateDelayTime(new BN(3)) // to mint a new block
      assert(forcedWithdrawalFee.eq(await this.staking.forcedWithdrawalFee()))
    }
  }).timeout(10000)

  it('Should setLPRewardAddress properly', async ()=>{
    const LPRewardAddress = this.accounts[8]
    await this.staking.setLPRewardAddress(LPRewardAddress)
    assert(LPRewardAddress !== await this.staking.LPRewardAddress())
    await sleep(Number(await this.staking.updateDelayTime())*1000)
    await this.staking.setUpdateDelayTime(new BN(3)) // to mint a new block
    assert(LPRewardAddress === await this.staking.LPRewardAddress())
  }).timeout(10000)

  it('Should setAPR properly', async ()=>{
    const APRInitVal = new BN(web3.utils.toWei('70', 'finney')) // it is 75 before
    const APRMinVal = new BN(web3.utils.toWei('7', 'finney')) // it is 5 before
    const APRDescMonthly = new BN(web3.utils.toWei('7', 'finney')) // it is 5 before
    try {
      await this.staking.setAPR( this.maxEmissionRate.div(new BN(2)).add(new BN(1)), APRMinVal, APRDescMonthly)
      assert(false)
    } catch(e) {
      assert(e.message.includes('_APRInitVal>maxEmissionRate/2 is not allowed'))
      await this.staking.setAPR( APRInitVal, APRMinVal, APRDescMonthly)
      const APR = await this.staking.APR()
      assert(APRInitVal.eq(APR.initVal))
      assert(APRMinVal.eq(APR.minVal))
      assert(APRDescMonthly.eq(APR.descMonthly))
    }
  }).timeout(10000)

  it('Should deposit properly', async ()=>{
    const amount = new BN(web3.utils.toWei('10')) // amount need big enough to calculate emission, amount too small emission might be 0
    // console.log('toWei', web3.utils.toWei('10'), amount.toString()) // toWei 10000000000000000000 10000000000000000000
    const sender = this.accounts[1]
    const oldBalance = await this.staking.balances(sender)
    try {
      await this.staking.deposit(0, {from: sender})
      assert(false)
    } catch (e) {
      assert(e.message.includes('deposit amount must > 0'))
      await this.staking.deposit(amount, {from: sender})
      if (oldBalance.eq(new BN(0))) { // first time deposit
        assert(oldBalance.add(amount).eq(await this.staking.balances(sender)))
      } else {
        assert(oldBalance.add(amount).lte(await this.staking.balances(sender))) // new balance might includes userSharing profit
      }
      // deposit again
      await sleep(5000)
      await this.staking.deposit(amount, {from: sender})
      const newBalance = await this.staking.balances(sender)
      // console.log('newBalance', newBalance.toString())
      assert(oldBalance.add(amount).add(amount).lt(newBalance)) // new balance includes userSharing profit
    }
  }).timeout(10000)

  it('Should withdraw properly', async ()=>{
    let tokenBalance1
    let tokenBalance2
    const sender = this.accounts[1]
    const amount = new BN(web3.utils.toWei('10'))
    const forcedWithdrawalFee = await this.staking.forcedWithdrawalFee()
    // console.log('forcedWithdrawalFee', forcedWithdrawalFee.toString(), forcedWithdrawalFee.toString().length)

    tokenBalance1 = await this.token.balanceOf(sender)
    await this.staking.deposit(amount, {from: sender, gas: 3000000}) // to renew depositDate
    await this.staking.withdraw(amount, {from: sender, gas: 3000000}) // force withdraw fee needed. it might out of gas if without gas paramter
    tokenBalance2 = await this.token.balanceOf(sender)
    const fee = amount.mul(forcedWithdrawalFee).div(new BN(web3.utils.toWei('1'))) // withdraw fee
    console.log(tokenBalance1.sub(tokenBalance2).toString(), fee.toString())
    assert(tokenBalance1.sub(tokenBalance2).eq(fee))

    tokenBalance1 = await this.token.balanceOf(sender)
    await this.staking.deposit(amount, {from: sender}) // to renew depositDate
    await sleep(await this.staking.withdrawalLockDuration()*1000)
    await this.staking.withdraw(amount, {from: sender}) // after LockDuration, 0 fee for withdraw
    tokenBalance2 = await this.token.balanceOf(sender)
    const accruedEmission = await this.staking.getAccruedEmission(await this.staking.depositDates(sender), amount)
    console.log('accruedEmission', accruedEmission.userShare.toString())
    console.log('tokenBalance2 - tokenBalance1 =', tokenBalance2.sub(tokenBalance1).toString(), tokenBalance2.sub(tokenBalance1).toString().length)
    assert(tokenBalance1.lt(tokenBalance2))
  }).timeout(10000)

  it('Should accrue emission', async ()=>{
    // 
  })

})

function sleep(ms) {
  return new Promise((resolve, _)=>{setTimeout(()=>{resolve()}, ms )})
}
// https://testnet.bscscan.com/address/0x3326fc00E49e2416bE383e82d68315f53a181BCB#writeContract
const {
  BN,           // Big Number support
  constants,    // Common constants, like the zero address and largest integers
  expectEvent,  // Assertions for emitted events
  expectRevert, // Assertions for transactions that should fail
} = require('@openzeppelin/test-helpers')

const JoltifyCoin = artifacts.require('JoltifyCoin')
const Staking = artifacts.require('Staking')
describe('Jolt staking test', _=>{

  it("Should go to before block and can set timeout there", async ()=>{
    // console.log(typeof web3.utils.toWei('75', 'finney'), web3.utils.toWei('75', 'finney')); return; // string
    this.token = await JoltifyCoin.new()
    this.staking = await Staking.new()
    this.accounts = await web3.eth.getAccounts() // 0: admin, 1-2: for testing, 3: as LPRewardAddress tester
    await this.token.mint(this.accounts[1], 1000000)
    await this.token.mint(this.accounts[2], 1000000)
    await this.token.approve(this.staking.address, 1000000, {from: this.accounts[1]})
    await this.token.approve(this.staking.address, 1000000, {from: this.accounts[2]})
  }).timeout(10000)

  it('Should initialize staking properly', async ()=>{
    const init = {
      token: this.token.address,
      forcedWithdrawalFee: new BN(web3.utils.toWei('50', 'finney')), // 1 finney = 1/1000 ether
      withdrawalLockDuration: new BN(5), // seconds
      LPRewardAddress: this.accounts[3],
      APRInitVal: new BN(web3.utils.toWei('75', 'finney')),
      APRMinVal: new BN(web3.utils.toWei('5', 'finney')),
      APRDescMonthly: new BN(web3.utils.toWei('5', 'finney')),
      totalSupplyFactorInitVal: new BN(web3.utils.toWei('50', 'finney')),
      totalSupplyFactorMinVal: new BN(web3.utils.toWei('5', 'finney')),
      totalSupplyFactorDescMonthly: new BN(web3.utils.toWei('5', 'finney')),
      updateDelayTime: new BN(0)
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
  }).timeout(10000)

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
    const newUpdateDelayTime = new BN(5)
    assert(!oldUpdateDelayTime.eq(newUpdateDelayTime))
    await this.staking.setUpdateDelayTime(newUpdateDelayTime)
    assert( newUpdateDelayTime.eq(await this.staking.updateDelayTime()) )
  })

})
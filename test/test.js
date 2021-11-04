// require("@nomiclabs/hardhat-web3"); // https://github.com/nomiclabs/hardhat/issues/1930

const {
  BN,           // Big Number support
  constants,    // Common constants, like the zero address and largest integers
  expectEvent,  // Assertions for emitted events
  expectRevert, // Assertions for transactions that should fail
} = require('@openzeppelin/test-helpers');

const JoltifyCoin = artifacts.require('JoltifyCoin');

describe('Jolt', function ([sender, receiver]) {
  beforeEach(async function () {
    // The bundled BN library is the same one web3 uses under the hood
    this.value = new BN(1);

    this.joltifyCoin = await JoltifyCoin.new();
  });

  it('reverts when transferring tokens to the zero address', async function () {
    // Conditions that trigger a require statement can be precisely tested
    await expectRevert(
      this.joltifyCoin.transfer(constants.ZERO_ADDRESS, this.value, { from: sender }),
      'ERC20: transfer to the zero address',
    );
  });

  it('emits a Transfer event on successful transfers', async function () {
    const receipt = await this.joltifyCoin.transfer(
      receiver, this.value, { from: sender }
    );

    // Event assertions can verify that the arguments are the expected ones
    expectEvent(receipt, 'Transfer', {
      from: sender,
      to: receiver,
      value: this.value,
    });
  });

  it('updates balances on successful transfers', async function () {
    this.joltifyCoin.transfer(receiver, this.value, { from: sender });

    // BN assertions are automatically available via chai-bn (if using Chai)
    expect(await this.joltifyCoin.balanceOf(receiver))
      .to.be.bignumber.equal(this.value);
  });
}); 
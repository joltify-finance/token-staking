const contract = artifacts.require("LPMock");

module.exports = function (deployer) {
  deployer.deploy(contract);
};
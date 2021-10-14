const JoltifyStaking = artifacts.require("JoltifyStaking");

module.exports = function (deployer) {
  deployer.deploy(JoltifyStaking);
};

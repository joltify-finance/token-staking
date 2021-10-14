// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.9;

contract JoltifyStaking {
    address private admin;
    mapping(address => uint256) private deposits;
    uint256 public withdrawFreeLockDuration;
    uint256 public totalStaking;
    mapping(address => uint256) private depisitDates;
    uint8 public forceWithdrawFeePercent; // 0-100

    // event withdraw(address sender, uint256 amount, uint256 fee);
    // event deposit(address sender, uint256 amount);

    constructor() {
        withdrawFreeLockDuration = 48*3600; // 48 hours
        totalStaking = 0;
        admin = msg.sender;
        forceWithdrawFeePercent = 5; // init 5%
    }

    /**
    * if success, add to totalStaking
    * emit event
    * renew depisitDates[msg.sender]
    */
    function deposit(uint256 _amount) public {

    }

    /**
    * if tokenBalance is enough
    * if reach withdrawFreeLockDuration, withdraw freely, else, need 5% fee
    * emit event
    */
    function withdraw(uint256 _amount) public {

    }

    function getDeposited() public view returns(uint256 amount) {
        return deposits[msg.sender];
    }

    function changeAamin(address _newAdmin) public {
        require(msg.sender==admin, 'only admin allowed');
        admin = _newAdmin;
    }

    function changeWithdrawFreeLockDuration(uint256 _newValue) public {
        require(msg.sender==admin, 'only admin allowed');
        withdrawFreeLockDuration = _newValue;
    }

    function changeForceWithdrawFeePercent(uint8 _newValue) public {
        require(msg.sender==admin, 'only admin allowed');
        forceWithdrawFeePercent = _newValue;
    }

    function getProfit() public view returns(uint256) {

    }
}
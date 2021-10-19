// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.9;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/proxy/utils/initializable.sol";

contract Staking is Ownable, ReentrancyGuard, Initializable {
    // Sigmoid to be finished
    // mint tokens, some as userShared emission, the other, put into LP. Need puting LP?
    // there are two parts of emission rate, sigmoid calculated by time, and SupplyBasedEmissionRate

    using Address for address;
    using SafeMath for uint;
    using SafeERC20 for IERC20;

    uint8 public forcedWithdrawalFeePercent = 5; // in percent, 0: 0%, 100: 100%
    uint public withdrawLockDuration = 2*24*3600; // in second
    uint public totalStaked = 0;
    mapping(address=>uint) public deposits;
    mapping(address=>uint) public depositDates;
    IERC20 public token; // token that allowed to deposit

    function initialize(
        address _token,
        uint8 _forcedWithdrawalFeePercent,
        uint _withdrawLockDuration
    ) external initializer {
        require(_token.isContract(), "not a contract address");
        require(_forcedWithdrawalFeePercent<=100, "forceWithdrawFeePercent must from 0 to 100");
        token = IERC20(_token);
        forcedWithdrawalFeePercent = _forcedWithdrawalFeePercent;
        withdrawLockDuration = _withdrawLockDuration;
    }

    function changeForcedWithdrawalFee(uint8 newFeePercnt) onlyOwner public {
        require(newFeePercnt<=100, "forceWithdrawFeePercent must from 0 to 100");
        forcedWithdrawalFeePercent = newFeePercnt;
    }

    function changeWithdrawLockDuration(uint newLockDuration) onlyOwner public {
        withdrawLockDuration = newLockDuration;
    }

    // to be completed
    function deposit(uint _amount) public {
        require(_amount>0, "deposit amount must > 0");
        deposits[msg.sender] = deposits[msg.sender].add(_amount);
        totalStaked = totalStaked.add(_amount);
        depositDates[msg.sender] = block.timestamp;
        // add old emission to deposits and totalStaked
        require(token.transferFrom(msg.sender, address(this), _amount), "transfer failed");
    }

    function withdraw(uint _amount) public nonReentrant {
        address _sender = msg.sender;
        uint amount = _amount;
        require( amount>0 && deposits[_sender]>=amount , "insufficient amount");
        deposits[_sender] = deposits[_sender].sub(amount);
        totalStaked = totalStaked.sub(amount);
        if ( depositDates[_sender].add(withdrawLockDuration) > block.timestamp) {
            amount = amount.mul(100-forcedWithdrawalFeePercent).div(100);
        }
        // add emission to amount, and withdraw togather
        require(token.transfer(_sender, amount), "transfer failed");
    }

    function getEmission() public view returns (uint userShared, uint forLiquidityPool) {
        address sender = msg.sender;
        uint depositDate = depositDates(msg.sender);
        if (0==depositDate || 0==deposits[sender]) {
            return (0, 0);
        }
        uint timePassed = block.timestamp.sub( depositDate );
        // to be finished
    }
}
// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.9;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/proxy/utils/initializable.sol";
import "./IERC20Mintable.sol";

contract Staking is Ownable, ReentrancyGuard, Initializable {

    using Address for address;
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    event Deposited(
        address indexed sender,
        uint256 amount,
        uint256 balance,
        uint256 accruedEmission,
        uint256 prevDepositDuration
    );

    event Withdrawn(
        address indexed sender,
        uint256 amount,
        uint256 fee,
        uint256 balance,
        uint256 accruedEmission,
        uint256 lastDepositDuration
    );

    event FeeSet(uint256 value, address sender);

    event TotalSupplyFactorSet(uint256 value, address sender);

    event LPRewardAddressSet(address value, address sender);

    uint256 public forcedWithdrawalFeePercent = 0.05 ether; // 1 ether->100%, 0.01 ether->1%, 0.075 ether->7.5%
    uint256 public APR = 0.15 ether; // 15%
    uint256 public withdrawLockDuration = 180; // in second
    uint256 public totalStaked = 0;
    mapping(address=>uint256) public balances; // token balance
    mapping(address=>uint256) public depositDates;
    IERC20Mintable public token; // token that allowed to deposit and it is mintable
    uint256 constant YEAR = 365 days; // https://docs.soliditylang.org/en/v0.8.9/units-and-global-variables.html
    address public LPRewardAddress;
    uint256 public maxEmissionRate = 0.15 ether; // 15%, to calculate total emission
    uint256 public totalSupplyFactor = 0.05 ether; // 5%. this means max calculated included of token.totalSupply()

    function initialize(
        address _tokenAddress, // test token(bsc testnet): 0xc52b99C1DaE2b7f1be2b40f44CE14921D436449E
        uint256 _forcedWithdrawalFeePercent,
        uint256 _withdrawLockDuration,
        address _LPRewardAddress,
        uint256 _totalSupplyFactor
    ) external initializer onlyOwner {
        require(_tokenAddress.isContract(), "not a contract address");
        require(_forcedWithdrawalFeePercent<=1 ether, "forceWithdrawFeePercent must <= 1 ether");
        token = IERC20Mintable(_tokenAddress);
        forcedWithdrawalFeePercent = _forcedWithdrawalFeePercent;
        withdrawLockDuration = _withdrawLockDuration;
        LPRewardAddress = _LPRewardAddress;
        totalSupplyFactor = _totalSupplyFactor;
    }

    function setLPRewardAddressSet(address _address) public onlyOwner {
        require(_address != address(0), "zero address");
        require(_address != address(this), "wrong address");
        LPRewardAddress = _address;
        emit LPRewardAddressSet(_address, msg.sender);
    }

    function setTotalSupplyFactor(uint256 _value) public onlyOwner {
        require(_value <= 1 ether, "should be less than or equal to 1 ether");
        totalSupplyFactor = _value;
        emit TotalSupplyFactorSet(_value, msg.sender);
    }

    function changeMaxEmissionRate(uint256 newRate) public onlyOwner {
        require(newRate<=1 ether, "maxEmissionRate must <= 1 ether");
        maxEmissionRate = newRate;
    }

    function changeForcedWithdrawalFee(uint256 newFeePercnt) public onlyOwner {
        require(newFeePercnt<=1 ether, "forceWithdrawFeePercent must <= 1 ether");
        forcedWithdrawalFeePercent = newFeePercnt;
        emit FeeSet(newFeePercnt, msg.sender);
    }

    function changeWithdrawLockDuration(uint256 newLockDuration) public onlyOwner {
        withdrawLockDuration = newLockDuration;
    }

    function deposit(uint256 _amount) public {
        require(_amount>0, "deposit amount must > 0");
        address _sender = msg.sender;
        (uint256 userShare, uint256 timePassed) = _mint(_sender, _amount); // emission was added to balances[_sender] and totalStaked in _mint()
        balances[_sender] = balances[_sender].add(_amount);
        totalStaked = totalStaked.add(_amount);
        depositDates[_sender] = block.timestamp;
        require(token.transferFrom(msg.sender, address(this), _amount), "transfer failed");
        emit Deposited(_sender, _amount, balances[_sender], userShare, timePassed);
    }

    function withdraw(uint256 _amount) public nonReentrant {
        address _sender = msg.sender;
        require( _amount>0 && balances[_sender]>=_amount , "insufficient amount");
        (uint256 userShare, uint256 timePassed) = _mint(_sender, _amount); // emission was added to balances[_sender] and totalStaked in _mint()
        uint256 amount = _amount;
        amount = _amount.add(userShare); // withdraw emission together
        balances[_sender] = balances[_sender].sub(amount);
        totalStaked = totalStaked.sub(amount);
        uint256 fee = 0;
        if ( depositDates[_sender].add(withdrawLockDuration) > block.timestamp ) {
            fee = amount.mul(forcedWithdrawalFeePercent).div(1 ether);
            amount = amount.sub( fee );
        }
        require(token.transfer(_sender, amount), "transfer failed");
        emit Withdrawn(_sender, amount, fee, balances[_sender], userShare, timePassed);
    }

    function _mint(address _user, uint256 _amount) internal returns (uint256 userShare, uint256 timePassed) {
        uint256 currentBalance = balances[_user];
        uint256 amount = _amount == 0 ? currentBalance : _amount; // if withdraw 0, it means withdraw all
        (uint256 total, uint256 _userShare, uint256 _timePassed) = getAccruedEmission(depositDates[_user], amount);
        if (total > 0) {
            require(token.mint(address(this), total), "minting failed");
            balances[_user] = currentBalance.add(_userShare);
            totalStaked = totalStaked.add(_userShare);
            require(token.transfer(LPRewardAddress, total.sub(_userShare)), "transfer failed");
        }
        return (_userShare, _timePassed);
    }

    // total and timePassed returns 0?
    function getAccruedEmission(uint256 _depositDate, uint256 _amount) public view returns (uint256 total, uint256 userShare, uint256 timePassed) {
        if (0==_depositDate || 0==_amount) {
            return (0, 0, 0);
        }
        timePassed = block.timestamp.sub( _depositDate );
        uint256 userEmissionRate = APR.add( getSupplyBasedEmissionRate() );
        userShare = _amount.mul(userEmissionRate).mul(timePassed).div(YEAR * 1 ether);
        total = _amount.mul(maxEmissionRate).mul(timePassed).div(YEAR * 1 ether);
    }

    function getSupplyBasedEmissionRate() public view returns (uint256) {
        uint256 totalSupply = token.totalSupply();
        if (0==totalSupplyFactor) {
            return 0;
        }
        uint256 target = totalSupply.mul(totalSupplyFactor).div(1 ether); // part of totalSupply
        uint256 maxSupplyBasedEmissionRate = maxEmissionRate.div(2);
        if (totalStaked >= target) {
            return maxSupplyBasedEmissionRate;
        }
        return maxSupplyBasedEmissionRate.mul(totalStaked).div(target);
    }

    event OnTokenTransfer(address _sender, uint256 _amount, string _calldata);
    function onTokenTransfer(address _sender, uint256 _amount, bytes memory _calldata) external returns (bool) {
        emit OnTokenTransfer(_sender, _amount, string(_calldata));
        return true;
    }
}
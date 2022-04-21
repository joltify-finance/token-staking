// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.9;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/proxy/utils/initializable.sol";

interface IERC20Mintable {
    function transfer(address _to, uint256 _value) external returns (bool);
    function transferFrom(address _from, address _to, uint256 _value) external returns (bool);
    function mint(address to, uint256 amount) external;
    function balanceOf(address _account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
}

contract Staking is Ownable, ReentrancyGuard, Initializable {

    using Address for address;
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    struct UintParam {
        uint256 oldValue;
        uint256 newValue;
        uint256 timestamp;
    }

    struct AddressParam {
        address oldValue;
        address newValue;
        uint256 timestamp;
    }

    struct UintHistory {
        uint256 timestamp;
        uint256 value;
    }

    AddressParam public LPRewardAddressParam;
    UintParam public forcedWithdrawalFeeParam;
    UintParam public withdrawalLockDurationParam; // need fee if forced withdraw
    UintParam public basicAPRParam;

    uint256 public totalStaked;
    mapping(address=>uint256) public balances;
    mapping(address=>uint256) public balancesReward;
    mapping(address=>uint256) public depositDates;
    IERC20Mintable public token; // LP token, for staking
    IERC20Mintable public tokenReward; // JOLT token, for reward

    UintHistory[] public APRHistories;

    uint256 private constant YEAR = 365 days;
    uint256 private constant ONE_ETHER = 1 ether;
    uint256 public constant PARAM_UPDATE_DELAY = 5 days; // default 5 days
    uint256 public constant USER_SHARE_RATE = 1 ether;

    function initialize(
        address _tokenAddress, // LP
        uint256 _forcedWithdrawalFee, // default 5%
        uint256 _withdrawalLockDuration, // default 3 days
        address _LPRewardAddress,
        uint256 _basicAPR, // default 200%
        address _tokenRewardAddress // JOLT
    ) external initializer onlyOwner {
        require(_tokenAddress.isContract(), "not a contract address");
        require(_tokenRewardAddress.isContract(), "not a contract address");
        token = IERC20Mintable(_tokenAddress);
        setForcedWithdrawalFee(_forcedWithdrawalFee);
        setWithdrawalLockDuration(_withdrawalLockDuration);
        setLPRewardAddress(_LPRewardAddress);
        setBasicAPR(_basicAPR);
        tokenReward = IERC20Mintable(_tokenRewardAddress);
    }

    function basicAPR() public view returns (uint256) {
        return _getUintParamValue(basicAPRParam);
    }

    event BasicAPRSet(uint256 value, address sender);
    function setBasicAPR(uint256 _value) public onlyOwner { // can be any value from 0, even bigger than 100%, for exampel, 300%
        uint256 historyTime = block.timestamp;
        if (basicAPRParam.timestamp > 0) {
            historyTime += PARAM_UPDATE_DELAY;
        }
        APRHistories.push( UintHistory( {timestamp: historyTime, value: _value} ) );
        _updateUintParam(basicAPRParam, _value);
        emit BasicAPRSet(_value, msg.sender);
    }

    event WithdrawalLockDurationSet(uint256 value, address sender);
    function setWithdrawalLockDuration(uint256 _value) public onlyOwner {
        require(_value <= 30 days, "shouldn't be greater than 30 days");
        _updateUintParam(withdrawalLockDurationParam, _value);
        emit WithdrawalLockDurationSet(_value, msg.sender);
    }

    function withdrawalLockDuration() public view returns (uint256) {
        return _getUintParamValue(withdrawalLockDurationParam);
    }

    event ForcedWithdrawalFeeSet(uint256 value, address sender);
    function setForcedWithdrawalFee(uint256 _value) public onlyOwner {
        require(_value <= ONE_ETHER, "should be less than or equal to 1 ether");
        _updateUintParam(forcedWithdrawalFeeParam, _value);
        emit ForcedWithdrawalFeeSet(_value, msg.sender);
    }

    function forcedWithdrawalFee() public view returns (uint256) {
        return _getUintParamValue(forcedWithdrawalFeeParam);
    }

    event LPRewardAddressSet(address value, address sender);
    function setLPRewardAddress(address _address) public onlyOwner {
        require(_address != address(0), "zero address");
        require(_address != address(this), "wrong address");
        AddressParam memory param = LPRewardAddressParam;
        if (param.timestamp == 0) {
            param.oldValue = _address;
        } else if (_paramUpdateDelayElapsed(param.timestamp)) { // oldVal not in use, change it
            param.oldValue = param.newValue;
        }
        param.newValue = _address;
        param.timestamp = block.timestamp;
        LPRewardAddressParam = param;
        emit LPRewardAddressSet(_address, msg.sender);
    }

    function LPRewardAddress() public view returns (address) {
        AddressParam memory param = LPRewardAddressParam;
        return _paramUpdateDelayElapsed(param.timestamp) ? param.newValue : param.oldValue;
    }

    function _updateUintParam(UintParam storage _param, uint256 _newValue) internal {
        if (_param.timestamp == 0) {
            _param.oldValue = _newValue;
        } else if (_paramUpdateDelayElapsed(_param.timestamp)) { // oldVal not in use, change it
            _param.oldValue = _param.newValue;
        }
        _param.newValue = _newValue;
        _param.timestamp = block.timestamp;
    }

    function _getUintParamValue(UintParam memory _param) internal view returns (uint256) {
        return _paramUpdateDelayElapsed(_param.timestamp) ? _param.newValue : _param.oldValue;
    }

    function _paramUpdateDelayElapsed(uint256 _paramTimestamp) internal view returns (bool) {
        return block.timestamp >= _paramTimestamp.add(PARAM_UPDATE_DELAY);
    }

    event Deposited(
        address indexed sender,
        uint256 amount,
        uint256 balance,
        uint256 accruedEmission,
        uint256 prevDepositDuration
    );
    function deposit(uint256 _amount) public {
        require(_amount>0, "deposit amount must > 0");
        address _sender = msg.sender;
        // _mint's second argument must be 0, so that it can calculate emission by old balance
        (uint256 userShare, uint256 timePassed) = _mint(_sender, 0); // emission was added to balancesJolt[_sender] in _mint()
        uint256 newBalance = balances[_sender].add(_amount);
        balances[_sender] = newBalance;
        totalStaked = totalStaked.add(_amount);
        depositDates[_sender] = block.timestamp;
        require(token.transferFrom(_sender, address(this), _amount), "transfer failed");
        emit Deposited(_sender, _amount, newBalance, userShare, timePassed);
    }

    event Withdrawn(
        address indexed sender,
        uint256 amount,
        uint256 fee,
        uint256 balance,
        uint256 amountReward,
        uint256 feeReward,
        uint256 balanceReward,
        uint256 accruedEmission,
        uint256 lastDepositDuration
    );
    function withdraw(uint256 _amount) public nonReentrant {
        address _sender = msg.sender;
        require( balances[_sender] >= _amount , "insufficient amount");
        uint256 amount = 0==_amount ? balances[_sender] : _amount;
        uint256 amountReward = 0;
        (uint256 accruedEmission, uint256 timePassed) = _mint(_sender, balances[_sender]); // use LP balance to calc emission, then add to JOTL balance
        if (balances[_sender]>0) {
            amountReward = amount.mul(balancesReward[_sender]).div(balances[_sender]);
        }
        balances[_sender] = balances[_sender].sub(amount);
        balancesReward[_sender] = balancesReward[_sender].sub(amountReward);
        totalStaked = totalStaked.sub(amount);
        uint256 fee = 0;
        uint256 feeReward = 0;
        if ( depositDates[_sender].add(withdrawalLockDuration()) > block.timestamp ) {
            fee = amount.mul(forcedWithdrawalFee()).div(ONE_ETHER);
            amount = amount.sub( fee );
            if (fee>0) {
                require(token.transfer(LPRewardAddress(), fee), "transfer failed"); // forced fee transfer to LP reward address
            }
            feeReward = amountReward.mul(forcedWithdrawalFee()).div(ONE_ETHER);
            amountReward = amountReward.sub( feeReward );
            if (feeReward>0) {
                require(tokenReward.transfer(LPRewardAddress(), feeReward), "transfer failed"); // forced fee transfer to LP reward address
            }
        }
        require(token.transfer(_sender, amount), "transfer failed");
        require(tokenReward.transfer(_sender, amountReward), "transfer failed");
        emit Withdrawn(_sender, amount, fee, balances[_sender], amountReward, feeReward, balancesReward[_sender], accruedEmission, timePassed);
    }

    function _mint(address _user, uint256 _amount) internal returns (uint256, uint256) {
        uint256 amount = _amount == 0 ? balances[_user] : _amount;
        (uint256 total, uint256 userShare, uint256 timePassed) = getAccruedEmission(depositDates[_user], amount);
        if (total > 0) {
            tokenReward.mint(address(this), total);
            balancesReward[_user] = balancesReward[_user].add(userShare);
            require(userShare<=total, "userShare>total is not allowed");
            if (total>userShare) {
                require(tokenReward.transfer(LPRewardAddress(), total.sub(userShare)), "transfer failed");
            }
        }
        return (userShare, timePassed);
    }

    function getAccruedEmission(uint256 _depositDate, uint256 _amount) public view returns (uint256 total, uint256 userShare, uint256 timePassed) {
        if (0==_depositDate || 0==_amount) {
            return (0, 0, 0);
        }
        uint256 currentTime = block.timestamp;
        timePassed = currentTime.sub(_depositDate); // return value

        uint256[] memory timePoints = new uint256[](APRHistories.length.add(1));
        uint256 timePointsIndex = 0;
        timePoints[timePointsIndex] = _depositDate;
        timePointsIndex ++;

        uint256[] memory APRs = new uint256[](APRHistories.length);
        uint256 APRsIndex = 0;
        APRs[APRsIndex] = APRHistories[0].value;
        APRsIndex ++;

        for(uint256 i=1; i<APRHistories.length; i++) {
            if (APRHistories[i].timestamp < currentTime) { // APR set update need wait until PARAM_UPDATE_DELAY pass, thus, APRHistories[i].timestamp might be the future time
                if (APRHistories[i].timestamp>timePoints[timePointsIndex.sub(1)]) {
                    timePoints[timePointsIndex] = APRHistories[i].timestamp;
                    timePointsIndex ++;
                    APRs[APRsIndex] = APRHistories[i].value;
                    APRsIndex++;
                } else { // i is within the length of APRHistories, APRHistories[i].value will always be positive number
                    APRs[0] = APRHistories[i].value;
                }
            }
        }
        timePoints[timePointsIndex] = currentTime;
        timePointsIndex++;
        for (uint256 j=0; j<timePointsIndex.sub(1); j++) {
            uint256 emission;
            {
                emission = _amount.mul( timePoints[j+1].sub(timePoints[j]) ).mul(APRs[j]);
            }
            {
                emission = emission.div(YEAR).div(ONE_ETHER);
            }
            total = total.add(emission);
        }
        userShare = total.mul(USER_SHARE_RATE).div(ONE_ETHER); // return value
    }
}
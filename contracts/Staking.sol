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

    struct APRHistory {
        uint256 timestamp;
        uint256 APR;
    }

    AddressParam public LPRewardAddressParam;
    UintParam public forcedWithdrawalFeeParam;
    UintParam public withdrawalLockDurationParam;
    UintParam public totalSupplyFactorParam;
    UintParam public basicAPRParam;
    UintParam public monthlyDescRateParam;
    UintParam public differentialTimeParam;

    uint256 public startTime; // to calculate APR desc
    uint256 public totalStaked;
    mapping(address=>uint256) public balances;
    mapping(address=>uint256) public depositDates;
    IERC20Mintable public token;

    APRHistory[] public APRHistories;

    uint256 private constant YEAR = 365 days; // https://docs.soliditylang.org/en/v0.8.9/units-and-global-variables.html
    uint256 private constant ONE_ETHER = 1 ether;
    // uint256 public constant MAX_EMISSION_RATE = 0.15 ether;
    uint256 public constant PARAM_UPDATE_DELAY = 7 days;

    function initialize(
        address _tokenAddress,
        uint256 _forcedWithdrawalFee,
        uint256 _withdrawalLockDuration,
        address _LPRewardAddress,
        uint256 _totalSupplyFactor,
        uint256 _basicAPR,
        uint256 _monthlyDescRate,
        uint256 _differentialTime
    ) external initializer onlyOwner {
        require(_tokenAddress.isContract(), "not a contract address");
        token = IERC20Mintable(_tokenAddress);
        setForcedWithdrawalFee(_forcedWithdrawalFee);
        setWithdrawalLockDuration(_withdrawalLockDuration);
        setLPRewardAddress(_LPRewardAddress);
        setTotalSupplyFactor(_totalSupplyFactor);
        setBasicAPR(_basicAPR);
        setMonthlyDescRate(_monthlyDescRate);
        setDifferentialTime(_differentialTime);
        startTime = block.timestamp;
    }

    function differentialTime() public view returns (uint256) {
        return _getUintParamValue(differentialTimeParam);
    }

    event DifferentialTimeSet(uint256 value, address sender);
    function setDifferentialTime(uint256 _value) public onlyOwner {
        require(_value>0, "should be a positive integer");
        _updateUintParam(differentialTimeParam, _value); // if very large, APR drops very quickly
        emit DifferentialTimeSet(_value, msg.sender);
    }

    function monthlyDescRate() public view returns (uint256) {
        return _getUintParamValue(monthlyDescRateParam);
    }

    event MonthlyDescRateSet(uint256 value, address sender);
    function setMonthlyDescRate(uint256 _value) public onlyOwner {
        _updateUintParam(monthlyDescRateParam, _value); // if very large, APR drops very quickly
        emit MonthlyDescRateSet(_value, msg.sender);
    }

    function basicAPR() public view returns (uint256) {
        return _getUintParamValue(basicAPRParam);
    }

    event BasicAPRSet(uint256 value, address sender);
    function setBasicAPR(uint256 _value) public onlyOwner { // can be any value from 0, even bigger than 100%, for exampel 300%
        _updateUintParam(basicAPRParam, _value);
        APRHistories.push( APRHistory( {timestamp: block.timestamp, APR: _value} ) );
        emit BasicAPRSet(_value, msg.sender);
    }

    function totalSupplyFactor() public view returns (uint256) {
        return _getUintParamValue(totalSupplyFactorParam);
    }

    event TotalSupplyFactorSet(uint256 value, address sender);
    function setTotalSupplyFactor(uint256 _value) public onlyOwner {
        require(_value <= 1 ether, "should be less than or equal to 1 ether");
        _updateUintParam(totalSupplyFactorParam, _value);
        emit TotalSupplyFactorSet(_value, msg.sender);
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
        require(_value <= 1 ether, "should be less than or equal to 1 ether");
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
        (uint256 userShare, uint256 timePassed) = _mint(_sender, 0); // emission was added to balances[_sender] and totalStaked in _mint()
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
        uint256 accruedEmission,
        uint256 lastDepositDuration
    );
    function withdraw(uint256 _amount) public nonReentrant {
        address _sender = msg.sender;
        require( balances[_sender] >= _amount , "insufficient amount");
        uint256 amount = 0==_amount ? balances[_sender] : _amount;
        (uint256 accruedEmission, uint256 timePassed) = _mint(_sender, amount); // emission was added to balances[_sender] and totalStaked in _mint()
        amount = amount.add(accruedEmission); // withdraw emission together
        balances[_sender] = balances[_sender].sub(amount);
        totalStaked = totalStaked.sub(amount);
        uint256 fee = 0;
        if ( depositDates[_sender].add(withdrawalLockDuration()) > block.timestamp ) {
            fee = amount.mul(forcedWithdrawalFee()).div(1 ether);
            amount = amount.sub( fee );
            require(token.transfer(LPRewardAddress(), fee), "transfer failed"); // forced fee transfer to LP reward address
        }
        require(token.transfer(_sender, amount), "transfer failed");
        emit Withdrawn(_sender, amount, fee, balances[_sender], accruedEmission, timePassed);
    }

    function _mint(address _user, uint256 _amount) internal returns (uint256, uint256) {
        uint256 currentBalance = balances[_user];
        uint256 amount = _amount == 0 ? currentBalance : _amount;
        (uint256 total, uint256 userShare, uint256 timePassed) = getAccruedEmission(depositDates[_user], amount);
        if (total > 0) {
            token.mint(address(this), total);
            balances[_user] = currentBalance.add(userShare);
            totalStaked = totalStaked.add(userShare);
            require(userShare<total, "userShare>=total is not allowed");
            require(token.transfer(LPRewardAddress(), total.sub(userShare)), "transfer failed");
        }
        return (userShare, timePassed);
    }

    function getAccruedEmission(uint256 _depositDate, uint256 _amount) public view returns (uint256 total, uint256 userShare, uint256 timePassed) {
        if (0==_depositDate || 0==_amount) {
            return (0, 0, 0);
        }
        uint256 blockTime = block.timestamp;
        timePassed = _depositDate.sub( startTime ); // return value
        uint256 _differentialTime = differentialTime();
        uint256 fragments = timePassed.div(differentialTime());

        uint256 _monthlyDescRate = monthlyDescRate();

        uint256 APR = APRHistories[0].APR;
        uint256 j = 1;
        total = 0; // return value
        for (uint256 i=0; i<=fragments; i++) {
            uint256 timePoint = startTime.add(_differentialTime.mul(i.add(1)));
            if ( timePoint==startTime || timePoint>startTime.add(timePassed)) {
                timePoint = startTime.add(timePassed);
            }

            if (timePoint > blockTime) {
                _differentialTime -= timePoint - blockTime;
                timePoint = blockTime;
            }

            uint256 descRate = (timePoint.sub(startTime)).mul(_monthlyDescRate).div(30 days);

            while(APRHistories[j].timestamp>0 &&  timePoint>APRHistories[j].timestamp) {
                APR = APRHistories[j].APR;
                j++;
            }

            if (descRate < 1 ether) {
                uint256 APRLeft = ONE_ETHER.sub(descRate);
                total += _differentialTime.mul(APR.mul(APRLeft)).div(YEAR);
            } else {
                break;
            }
        }
        userShare = total.mul(0.8 ether).div(ONE_ETHER);

    }

    event onTokenTransfered(address sender, uint256 amount, string callData);
    function onTokenTransfer(address _sender, uint256 _amount, bytes memory _calldata) external returns (bool) {
        emit onTokenTransfered(_sender, _amount, string(_calldata));
        return true;
    }
}
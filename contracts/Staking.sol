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

    struct APRStruct {
        uint256 initVal;
        uint256 minVal;
        uint256 descMonthly;
    }

    AddressParam public LPRewardAddressParam;
    UintParam public forcedWithdrawalFeeParam = UintParam({oldValue: 0.05 ether, newValue: 0.05 ether, timestamp: block.timestamp}); // 1 ether->100%, 0.01 ether->1%, 0.075 ether->7.5%
    UintParam public withdrawalLockDurationParam = UintParam({oldValue: 180, newValue: 180, timestamp: block.timestamp}); // in second
    UintParam public totalSupplyFactorParam = UintParam({oldValue: 0.05 ether, newValue: 0.05 ether, timestamp: block.timestamp}); // 5%. this means max calculated included of token.totalSupply()
    
    uint256 public startTime = block.timestamp; // to calculate APR desc
    uint256 public totalStaked = 0;
    mapping(address=>uint256) public balances; // token balance
    mapping(address=>uint256) public depositDates;
    IERC20Mintable public token; // token that allowed to deposit and it is mintable
    uint256 constant YEAR = 365 days; // https://docs.soliditylang.org/en/v0.8.9/units-and-global-variables.html
    uint256 public maxEmissionRate = 0.15 ether; // 15%, to calculate total emission
    uint256 public updateDelayTime = 7 days;
    
    APRStruct public APR = APRStruct({
        initVal: 0.15 ether,
        minVal: 0.01 ether,
        descMonthly: 0.01 ether // descend 1% of initVal per month, but calculate by second
    });

    function initialize(
        address _tokenAddress, // test token(bsc testnet): 0xc52b99C1DaE2b7f1be2b40f44CE14921D436449E
        uint256 _forcedWithdrawalFee,
        uint256 _withdrawalLockDuration,
        address _LPRewardAddress,
        uint256 _totalSupplyFactor,
        uint256 _APRInitVal,
        uint256 _APRMinVal,
        uint256 _APRDescMonthly
    ) external initializer onlyOwner {
        require(_tokenAddress.isContract(), "not a contract address");
        require(_forcedWithdrawalFee<=1 ether, "forceWithdrawFeePercent must <= 1 ether");
        token = IERC20Mintable(_tokenAddress);
        setForcedWithdrawalFee(_forcedWithdrawalFee);
        setWithdrawalLockDuration(_withdrawalLockDuration);
        setLPRewardAddress(_LPRewardAddress);
        setTotalSupplyFactor(_totalSupplyFactor);
        startTime = block.timestamp;
        APR.initVal = _APRInitVal;
        APR.minVal = _APRMinVal;
        APR.descMonthly = _APRDescMonthly;
    }

    event TotalSupplyFactorSet(uint256 _value, address _sender);
    function setTotalSupplyFactor(uint256 _value) public onlyOwner {
        require(_value <= 1 ether, "should be less than or equal to 1 ether");
        _updateUintParam(totalSupplyFactorParam, _value);
        emit TotalSupplyFactorSet(_value, msg.sender);
    }

    function totalSupplyFactor() public view returns (uint256) {
        return _getUintParamValue(totalSupplyFactorParam);
    }

    event WithdrawalLockDurationSet(uint256 _value, address _sender);
    function setWithdrawalLockDuration(uint256 _value) public onlyOwner {
        require(_value <= 30 days, "shouldn't be greater than 30 days");
        _updateUintParam(withdrawalLockDurationParam, _value);
        emit WithdrawalLockDurationSet(_value, msg.sender);
    }

    function withdrawalLockDuration() public view returns (uint256) {
        return _getUintParamValue(withdrawalLockDurationParam);
    }

    event ForcedWithdrawalFeeSet(uint256 _value, address _sender);
    function setForcedWithdrawalFee(uint256 _value) public onlyOwner {
        require(_value <= 1 ether, "should be less than or equal to 1 ether");
        _updateUintParam(forcedWithdrawalFeeParam, _value);
        emit ForcedWithdrawalFeeSet(_value, msg.sender);
    }

    function forcedWithdrawalFee() public view returns (uint256) {
        return _getUintParamValue(forcedWithdrawalFeeParam);
    }

    event LPRewardAddressSet(address _address, address _sender);
    function setLPRewardAddress(address _address) public onlyOwner {
        require(_address != address(0), "zero address");
        require(_address != address(this), "wrong address");
        AddressParam memory param = LPRewardAddressParam;
        if (param.timestamp == 0) {
            param.oldValue = _address;
        } else if (_paramUpdateDelayElapsed(param.timestamp)) {
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
        } else if (_paramUpdateDelayElapsed(_param.timestamp)) {
            _param.oldValue = _param.newValue;
        }
        _param.newValue = _newValue;
        _param.timestamp = block.timestamp;
    }

    function _getUintParamValue(UintParam memory _param) internal view returns (uint256) {
        return _paramUpdateDelayElapsed(_param.timestamp) ? _param.newValue : _param.oldValue;
    }

    function _paramUpdateDelayElapsed(uint256 _paramTimestamp) internal view returns (bool) {
        return block.timestamp > _paramTimestamp.add(updateDelayTime);
    }

    function getAPR() public view returns(uint256 APRNow) {
        uint256 descPerSecond = APR.descMonthly.div(24*3600*30);
        uint256 secondsPassed = block.timestamp.sub(startTime);
        if ( APR.initVal.sub(descPerSecond.mul(secondsPassed)) > APR.minVal ) {
            return APR.initVal.sub(descPerSecond.mul(secondsPassed));
        }
        return APR.minVal;
    }

    function setAPR(uint256 _APRInitVal, uint256 _APRMinVal, uint256 _APRDescMonthly) public onlyOwner {
        APR.initVal = _APRInitVal;
        APR.minVal = _APRMinVal;
        APR.descMonthly = _APRDescMonthly;
    }

    event Deposited(
        address indexed sender,
        uint256 amount,
        uint256 balance,
        uint256 accruedEmission,
        uint256 prevDepositDuration
    );
    function deposit(uint256 _amount) public { // nonReentrant?? gas费？
        require(_amount>0, "deposit amount must > 0");
        address _sender = msg.sender;
        // _mint's second argument must be 0, so that it can calculate emission by old balance
        (uint256 userShare, uint256 timePassed) = _mint(_sender, 0); // emission was added to balances[_sender] and totalStaked in _mint()
        balances[_sender] = balances[_sender].add(_amount);
        totalStaked = totalStaked.add(_amount);
        depositDates[_sender] = block.timestamp;
        require(token.transferFrom(msg.sender, address(this), _amount), "transfer failed");
        emit Deposited(_sender, _amount, balances[_sender], userShare, timePassed);
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
        require( _amount>0 && balances[_sender]>=_amount , "insufficient amount");
        (uint256 userShare, uint256 timePassed) = _mint(_sender, _amount); // emission was added to balances[_sender] and totalStaked in _mint()
        uint256 amount = _amount;
        amount = amount.add(userShare); // withdraw emission together
        balances[_sender] = balances[_sender].sub(amount);
        totalStaked = totalStaked.sub(amount);
        uint256 fee = 0;
        if ( depositDates[_sender].add(withdrawalLockDuration()) > block.timestamp ) {
            fee = amount.mul(forcedWithdrawalFee()).div(1 ether);
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
            require(token.transfer(LPRewardAddress(), total.sub(_userShare)), "transfer failed");
        }
        return (_userShare, _timePassed);
    }

    function getAccruedEmission(uint256 _depositDate, uint256 _amount) public view returns (uint256 total, uint256 userShare, uint256 timePassed) {
        if (0==_depositDate || 0==_amount) {
            return (0, 0, 0);
        }
        timePassed = block.timestamp.sub( _depositDate );
        uint256 userEmissionRate = getAPR().add( getSupplyBasedEmissionRate() );
        userShare = _amount.mul(userEmissionRate).mul(timePassed).div(YEAR * 1 ether);
        total = _amount.mul(maxEmissionRate).mul(timePassed).div(YEAR * 1 ether);
    }

    function getSupplyBasedEmissionRate() public view returns (uint256) {
        uint256 totalSupply = token.totalSupply();
        if (0==totalSupplyFactor()) {
            return 0;
        }
        uint256 target = totalSupply.mul(totalSupplyFactor()).div(1 ether); // part of totalSupply
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
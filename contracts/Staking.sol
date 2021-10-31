// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.9;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/proxy/utils/initializable.sol";
// import "./IERC20Mintable.sol";

interface IERC20Mintable {
    function transfer(address _to, uint256 _value) external returns (bool);
    function transferFrom(address _from, address _to, uint256 _value) external returns (bool);
    // function mint(address _to, uint256 _value) external returns (bool);
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

    struct LinearDesc {
        uint256 initVal;
        uint256 minVal;
        uint256 descMonthly;
    }

    AddressParam public LPRewardAddressParam;
    UintParam public forcedWithdrawalFeeParam = UintParam({oldValue: 0.05 ether, newValue: 0.05 ether, timestamp: block.timestamp}); // 1 ether->100%, 0.01 ether->1%, 0.075 ether->7.5%
    UintParam public withdrawalLockDurationParam = UintParam({oldValue: 180, newValue: 180, timestamp: block.timestamp}); // in second

    uint256 public startTime = block.timestamp; // to calculate APR desc
    uint256 public totalStaked = 0;
    mapping(address=>uint256) public balances; // token balance
    mapping(address=>uint256) public depositDates;
    IERC20Mintable public token; // token that allowed to deposit and it is mintable
    uint256 constant YEAR = 365 days; // https://docs.soliditylang.org/en/v0.8.9/units-and-global-variables.html
    uint256 public maxEmissionRate = 0.15 ether; // 15%, to calculate total emission
    uint256 public updateDelayTime = 7 days;
    
    LinearDesc public APR = LinearDesc({
        initVal: 0.15 ether,
        minVal: 0.01 ether,
        descMonthly: 0.01 ether // descend 1% of initVal per month, but calculate by second
    });

    LinearDesc public totalSupplyFactor = LinearDesc({
        initVal: 0.05 ether,
        minVal: 0.005 ether,
        descMonthly: 0.005 ether // descend 0.5% of initVal per month, but calculate by second
    });

    function initialize(
        address _tokenAddress, // test token(bsc testnet): 0xc52b99C1DaE2b7f1be2b40f44CE14921D436449E
        uint256 _forcedWithdrawalFee,
        uint256 _withdrawalLockDuration,
        address _LPRewardAddress,
        uint256 _APRInitVal,
        uint256 _APRMinVal,
        uint256 _APRDescMonthly,
        uint256 _totalSupplyFactorInitVal,
        uint256 _totalSupplyFactorMinVal,
        uint256 _totalSupplyFactorDescMonthly
    ) external initializer onlyOwner {
        require(_tokenAddress.isContract(), "not a contract address");
        require(_forcedWithdrawalFee<=1 ether, "forceWithdrawFeePercent must <= 1 ether");
        token = IERC20Mintable(_tokenAddress);
        setForcedWithdrawalFee(_forcedWithdrawalFee);
        setWithdrawalLockDuration(_withdrawalLockDuration);
        setLPRewardAddress(_LPRewardAddress);
        startTime = block.timestamp;
        APR.initVal = _APRInitVal;
        APR.minVal = _APRMinVal;
        APR.descMonthly = _APRDescMonthly;
        totalSupplyFactor.initVal = _totalSupplyFactorInitVal;
        totalSupplyFactor.minVal = _totalSupplyFactorMinVal;
        totalSupplyFactor.descMonthly = _totalSupplyFactorDescMonthly;
    }

    function getLinearDesc(LinearDesc memory params) internal view returns(uint256) {
        uint256 descPerSecond = params.descMonthly.div(24*3600*30);
        uint256 secondsPassed = block.timestamp.sub(startTime);
        if ( params.initVal.sub(descPerSecond.mul(secondsPassed)) > params.minVal ) {
            return params.initVal.sub(descPerSecond.mul(secondsPassed));
        }
        return params.minVal;
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

    function transferFromTest(address _sender, address _receiver, uint256 _amount) public onlyOwner returns(bool) {
        return token.transferFrom(_sender, _receiver, _amount);
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

    // public, to test directly
    function _mint(address _user, uint256 _amount) public onlyOwner returns (uint256, uint256) {
        uint256 currentBalance = balances[_user];
        uint256 amount = _amount == 0 ? currentBalance : _amount;
        (uint256 total, uint256 userShare, uint256 timePassed) = getAccruedEmission(depositDates[_user], amount);
        if (total > 0) {
            // require(token.mint(address(this), total), "minting failed"); // mint can not work properly!!
            token.mint(address(this), total);
            balances[_user] = currentBalance.add(userShare);
            totalStaked = totalStaked.add(userShare);
            require(token.transfer(LPRewardAddress(), total.sub(userShare)), "transfer failed");
        }
        return (userShare, timePassed);
    }
    // test mint token bug: this function can't not work: test link: https://testnet.bscscan.com/address/0xfb22B3Cad99417120B2A0d18459E1E0c0ee8BD33#writeContract
    function mintToken(IERC20Mintable _token, uint256 _amount) public onlyOwner {
        _token.mint(address(this), _amount);
    }
    // this works fine
    function transferToken(IERC20Mintable _token, address _toAddress, uint256 _amount) public onlyOwner {
        _token.transfer(_toAddress, _amount);
    }

    function getAccruedEmission(uint256 _depositDate, uint256 _amount) public view returns (uint256 total, uint256 userShare, uint256 timePassed) {
        if (0==_depositDate || 0==_amount) {
            return (0, 0, 0);
        }
        timePassed = block.timestamp.sub( _depositDate );
        uint256 userEmissionRate = getLinearDesc(APR).add( getSupplyBasedEmissionRate() );
        userShare = _amount.mul(userEmissionRate).mul(timePassed).div(YEAR * 1 ether);
        total = _amount.mul(maxEmissionRate).mul(timePassed).div(YEAR * 1 ether);
    }

    function getSupplyBasedEmissionRate() public view returns (uint256) {
        uint256 totalSupply = token.totalSupply();
        uint256 _totalSupplyFactor = getLinearDesc(totalSupplyFactor);
        if (0==_totalSupplyFactor) {
            return 0;
        }
        uint256 target = totalSupply.mul(_totalSupplyFactor).div(1 ether); // part of token's totalSupply
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
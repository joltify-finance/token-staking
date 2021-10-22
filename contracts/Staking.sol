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

    // test private key: 0d7bcb669a61c4db754af3cbc70f446d0f299a54b43605b77d92f06efaee76f3

    using Address for address;
    using SafeMath for uint;
    using SafeERC20 for IERC20;

    event Deposited(
        address indexed sender,
        uint amount,
        uint balance,
        uint accruedEmission,
        uint prevDepositDuration
    );

    event Withdrawn(
        address indexed sender,
        uint amount,
        uint fee,
        uint balance,
        uint accruedEmission,
        uint lastDepositDuration
    );

    event FeeSet(uint value, address sender);

    event TotalSupplyFactorSet(uint value, address sender);

    event LPRewardAddressSet(address value, address sender);

    uint public forcedWithdrawalFeePercent = 0.05 ether; // 1 ether->100%, 0.01 ether->1%, 0.075 ether->7.5%
    uint public APR = 0.15 ether; // 15%
    uint public withdrawLockDuration = 180; // in second
    uint public totalStaked = 0;
    mapping(address=>uint) public balances; // token balance
    mapping(address=>uint) public depositDates;
    IERC20Mintable public token; // token that allowed to deposit and it is mintable
    uint constant YEAR = 365 days; // https://docs.soliditylang.org/en/v0.8.9/units-and-global-variables.html
    address public LPRewardAddress;
    uint public maxEmissionRate = 0.15 ether; // 15%, to calculate total emission
    uint public totalSupplyFactor = 0.05 ether; // 5%. this means max calculated included of token.totalSupply()

    function initialize(
        address _tokenAddress, // test token(bsc testnet): 0xc52b99C1DaE2b7f1be2b40f44CE14921D436449E
        uint _forcedWithdrawalFeePercent,
        uint _withdrawLockDuration,
        address _LPRewardAddress,
        uint _totalSupplyFactor
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

    function setTotalSupplyFactor(uint _value) public onlyOwner {
        require(_value <= 1 ether, "should be less than or equal to 1 ether");
        totalSupplyFactor = _value;
        emit TotalSupplyFactorSet(_value, msg.sender);
    }

    function changeMaxEmissionRate(uint newRate) public onlyOwner {
        require(newRate<=1 ether, "maxEmissionRate must <= 1 ether");
        maxEmissionRate = newRate;
    }

    function changeForcedWithdrawalFee(uint newFeePercnt) public onlyOwner {
        require(newFeePercnt<=1 ether, "forceWithdrawFeePercent must <= 1 ether");
        forcedWithdrawalFeePercent = newFeePercnt;
        emit FeeSet(newFeePercnt, msg.sender);
    }

    function changeWithdrawLockDuration(uint newLockDuration) public onlyOwner {
        withdrawLockDuration = newLockDuration;
    }

    function deposit(uint _amount) public {
        require(_amount>0, "deposit amount must > 0");
        address _sender = msg.sender;
        (uint userShare, uint timePassed) = _mint(_sender, _amount); // emission was added to balances[_sender] and totalStaked in _mint()
        balances[_sender] = balances[_sender].add(_amount);
        totalStaked = totalStaked.add(_amount);
        depositDates[_sender] = block.timestamp;
        require(token.transferFrom(msg.sender, address(this), _amount), "transfer failed");
        emit Deposited(_sender, _amount, balances[_sender], userShare, timePassed);
    }

    function withdraw(uint _amount) public nonReentrant {
        address _sender = msg.sender;
        require( _amount>0 && balances[_sender]>=_amount , "insufficient amount");
        (uint userShare, uint timePassed) = _mint(_sender, _amount); // emission was added to balances[_sender] and totalStaked in _mint()
        uint amount = _amount;
        amount = _amount.add(userShare); // withdraw emission together
        balances[_sender] = balances[_sender].sub(amount);
        totalStaked = totalStaked.sub(amount);
        uint fee = 0;
        if ( depositDates[_sender].add(withdrawLockDuration) > block.timestamp ) {
            fee = amount.mul(forcedWithdrawalFeePercent).div(1 ether);
            amount = amount.sub( fee );
        }
        require(token.transfer(_sender, amount), "transfer failed");
        emit Withdrawn(_sender, amount, fee, balances[_sender], userShare, timePassed);
    }

    // token need to set miner
    function _mint(address _user, uint _amount) internal returns (uint userShare, uint timePassed) {
        uint currentBalance = balances[_user];
        uint amount = _amount == 0 ? currentBalance : _amount; // if withdraw 0, it means withdraw all
        (uint total, uint _userShare, uint _timePassed) = getAccruedEmission(depositDates[_user], amount);
        if (total > 0) {
            require(token.mint(address(this), total), "minting failed");
            balances[_user] = currentBalance.add(_userShare);
            totalStaked = totalStaked.add(_userShare);
            require(token.transfer(LPRewardAddress, total.sub(_userShare)), "transfer failed");
        }
        return (_userShare, _timePassed);
    }

    function getAccruedEmission(uint _depositDate, uint _amount) public view returns (uint total, uint userShare, uint timePassed) {
        if (0==_depositDate || 0==_amount) {
            return (0, 0, 0);
        }
        uint _timePassed = block.timestamp.sub( _depositDate );
        uint userEmissionRate = APR.add( getSupplyBasedEmissionRate() );
        userShare = _amount.mul(userEmissionRate).mul(_timePassed).div(YEAR * 1 ether);
        total = _amount.mul(maxEmissionRate).mul(timePassed).div(YEAR * 1 ether);
    }

    function getSupplyBasedEmissionRate() public view returns (uint) {
        uint totalSupply = token.totalSupply();
        if (0==totalSupplyFactor) {
            return 0;
        }
        uint target = totalSupply.mul(totalSupplyFactor).div(1 ether); // part of totalSupply
        uint maxSupplyBasedEmissionRate = maxEmissionRate.div(2);
        if (totalStaked >= target) {
            return maxSupplyBasedEmissionRate;
        }
        return maxSupplyBasedEmissionRate.mul(totalStaked).div(target);
    }

    event OnTokenTransfer(address _sender, uint _amount, string _calldata);
    function onTokenTransfer(address _sender, uint _amount, bytes memory _calldata) external returns (bool) {
        emit OnTokenTransfer(_sender, _amount, string(_calldata));
        return true;
    }
}
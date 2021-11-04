// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.9;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Capped.sol";

contract JoltifyCoin is
    ERC20,
    ERC20Burnable,
    Pausable,
    AccessControl,
    ERC20Capped
{
    uint256 public capOfToken = 21000000 * 10**decimals(); // set max supply

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE"); // 0x65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE"); // 0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6

    constructor()
        ERC20("JoltifyCoin", "Jolt")
        ERC20Capped(capOfToken)
    {
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _setupRole(PAUSER_ROLE, msg.sender);
        _setupRole(MINTER_ROLE, msg.sender);
        // _mint(msg.sender, 210000 * 10 ** decimals());
    }

    function pause() public onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() public onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function _mint(address account, uint256 amount)
        internal
        override(ERC20, ERC20Capped)
    {
        require(
            ERC20.totalSupply() + amount <= cap(),
            "ERC20Capped: cap exceeded"
        );
        super._mint(account, amount);
    }

    function mint(address to, uint256 amount) public onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal override whenNotPaused {
        super._beforeTokenTransfer(from, to, amount);
    }
}
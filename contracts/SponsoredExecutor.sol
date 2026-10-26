// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SponsoredExecutor
/// @notice EIP-7702 delegation target used by Sponsor Desk.
///         A user's EOA delegates its code to this contract (type-0x04 authorization).
///         The user signs an EIP-712 `Execute` message off-chain; anyone (the sponsor)
///         can then submit `execute(...)` to the user's own address and pay the gas.
///         Inside each target call, `msg.sender` is the user's EOA, so the original
///         sender is preserved while the sponsor is the transaction's gas payer.
/// @dev    Storage lives in the user's account, so the nonce uses a namespaced slot
///         to avoid colliding with any other delegate the user may have used before.
contract SponsoredExecutor {
    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    bytes32 private constant CALL_TYPEHASH = keccak256("Call(address to,uint256 value,bytes data)");
    bytes32 private constant EXECUTE_TYPEHASH =
        keccak256("Execute(Call[] calls,uint256 nonce,uint256 deadline)Call(address to,uint256 value,bytes data)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("SponsorDeskExecutor");
    bytes32 private constant VERSION_HASH = keccak256("1");

    /// @dev keccak256("sponsordesk.executor.nonce") - 1
    bytes32 private constant NONCE_SLOT = bytes32(uint256(keccak256("sponsordesk.executor.nonce")) - 1);

    uint256 private constant HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    event Executed(address indexed account, address indexed relayer, uint256 nonce, uint256 callCount);

    error Expired();
    error BadSignature();
    error CallFailed(uint256 index, bytes reason);

    function nonce() public view returns (uint256 n) {
        bytes32 slot = NONCE_SLOT;
        assembly {
            n := sload(slot)
        }
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function hashExecute(Call[] calldata calls, uint256 n, uint256 deadline) public view returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            hashes[i] = keccak256(abi.encode(CALL_TYPEHASH, calls[i].to, calls[i].value, keccak256(calls[i].data)));
        }
        bytes32 structHash = keccak256(abi.encode(EXECUTE_TYPEHASH, keccak256(abi.encodePacked(hashes)), n, deadline));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @notice Execute a batch the account owner signed. Callable by anyone (e.g. a gas sponsor).
    function execute(Call[] calldata calls, uint256 deadline, bytes calldata signature) external payable {
        if (block.timestamp > deadline) revert Expired();
        uint256 n = nonce();
        if (msg.sender != address(this)) {
            bytes32 digest = hashExecute(calls, n, deadline);
            if (_recover(digest, signature) != address(this)) revert BadSignature();
        }
        bytes32 slot = NONCE_SLOT;
        assembly {
            sstore(slot, add(n, 1))
        }
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, bytes memory ret) = calls[i].to.call{value: calls[i].value}(calls[i].data);
            if (!ok) revert CallFailed(i, ret);
        }
        emit Executed(address(this), msg.sender, n, calls.length);
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        if (uint256(s) > HALF_N) return address(0);
        return ecrecover(digest, v, r, s);
    }

    // A delegated EOA must still be able to receive native tokens and NFTs.
    receive() external payable {}

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC1155BatchReceived.selector;
    }
}

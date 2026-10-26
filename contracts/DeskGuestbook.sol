// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title DeskGuestbook
/// @notice Tiny demo app for Sponsor Desk. `checkIn` records `msg.sender`, which lets the
///         live demo show that a sponsored call is attributed to the user, not the sponsor.
///         `setMotto` exists only so the demo can show a method that is NOT allowlisted.
contract DeskGuestbook {
    mapping(address => uint256) public checkIns;
    mapping(address => string) public motto;

    event CheckedIn(address indexed who, uint256 count, string note);
    event MottoSet(address indexed who, string motto);

    function checkIn(string calldata note) external {
        uint256 c = ++checkIns[msg.sender];
        emit CheckedIn(msg.sender, c, note);
    }

    function setMotto(string calldata m) external {
        motto[msg.sender] = m;
        emit MottoSet(msg.sender, m);
    }
}

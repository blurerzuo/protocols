// SPDX-License-Identifier: Apache-2.0
// Copyright 2017 Loopring Technology Limited.
pragma solidity ^0.7.0;

import "../../iface/ITokenPriceProvider.sol";

import "../../lib/MathUint.sol";


/// @author Brecht Devos - <brecht@loopring.org>
contract MovingAveragePriceProvider is ITokenPriceProvider
{
    using MathUint    for uint;

    ITokenPriceProvider public provider;

    uint public movingAverageTimePeriod;
    uint public numMovingAverageDataPoints;
    uint public defaultValue;

    uint public lastUpdateTime;

    uint[] internal history;
    uint internal movingAverage;
    uint internal updateIndex;

    event MovingAverageUpdated(
        uint timestamp,
        uint defaultValueUSD,
        uint movingAverageLRC
    );

    constructor(
        ITokenPriceProvider _provider,
        uint                _movingAverageTimePeriod,
        uint                _numMovingAverageDataPoints,
        uint                _defaultValue
        )
    {
        require(_movingAverageTimePeriod > 0, "INVALID_INPUT");
        require(_numMovingAverageDataPoints > 0, "INVALID_INPUT");
        require(_defaultValue > 0, "INVALID_INPUT");

        provider = _provider;
        movingAverageTimePeriod = _movingAverageTimePeriod;
        numMovingAverageDataPoints = _numMovingAverageDataPoints;
        defaultValue = _defaultValue;

        // Fill in the initial data points with the current LRC costs
        uint currentConversion = provider.usd2lrc(defaultValue);
        for (uint i = 0; i < numMovingAverageDataPoints; i++) {
            history.push(currentConversion);
        }
        movingAverage = currentConversion;
        lastUpdateTime = block.timestamp;
    }

    function usd2lrc(uint usd)
        external
        override
        view
        returns (uint)
    {
        return usd.mul(movingAverage) / defaultValue;
    }

    /// @dev Updates the simple moving average.
    ///      Can be called by anyone a single time every day.
    function updateMovingAverage()
        external
    {
        // Allow the costs to be updated every time span
        require(block.timestamp >= lastUpdateTime.add(movingAverageTimePeriod), "TOO_SOON");

        // Get the current price. Use the history array as a circular buffer
        history[updateIndex] = provider.usd2lrc(defaultValue);
        updateIndex = (updateIndex + 1) % numMovingAverageDataPoints;

        // Calculate the simple moving average over `numMovingAverageDataPoints` points
        uint newMovingAverage = 0;
        for (uint i = 0; i < numMovingAverageDataPoints; i++) {
            newMovingAverage = newMovingAverage.add(history[i]);
        }
        movingAverage = newMovingAverage / numMovingAverageDataPoints;

        lastUpdateTime = block.timestamp;

        emit MovingAverageUpdated(block.timestamp, defaultValue, movingAverage);
    }
}

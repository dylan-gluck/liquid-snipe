# Real-Time Market Data Integration

This document describes the comprehensive real-time market data integration implemented for the liquid-snipe trading bot.

## Overview

The price feed integration replaces mock data with real-time market feeds from multiple APIs, providing accurate pricing and liquidity data for trading decisions.

## Architecture

### Core Components

1. **PriceFeedService** (`src/data/price-feed-service.ts`)
   - Multi-source price aggregation (Coingecko + Birdeye)
   - Real-time WebSocket connections
   - Intelligent caching and rate limiting
   - Fallback mechanisms for high availability

2. **MarketDataManager** (`src/data/market-data-manager.ts`)
   - Comprehensive market condition analysis
   - Volatility and sentiment tracking
   - Portfolio exposure management
   - Trading recommendations

3. **PriceFeedMonitor** (`src/monitoring/price-feed-monitor.ts`)
   - Health monitoring and alerting
   - Circuit breaker patterns
   - Performance metrics tracking
   - Service availability monitoring

### Integration Points

- **TokenInfoService**: Enhanced with real-time price data
- **StrategyEngine**: Uses real liquidity data for trading decisions
- **Core Controller**: Orchestrates all price feed components

## API Integration

### Coingecko API
- **Primary use**: General token pricing and market data
- **Rate limit**: 10-50 requests/minute (configurable)
- **Fallback**: Used for major tokens and cross-validation

### Birdeye API
- **Primary use**: Solana-specific pool data and liquidity
- **Rate limit**: 100+ requests/minute (based on plan)
- **Specialization**: DEX pool analysis and volume data

## Features

### Real-Time Data
- WebSocket connections for instant price updates
- Pool liquidity monitoring
- Volume and trading activity tracking
- Market condition assessment

### Reliability & Resilience
- Circuit breaker patterns for API failures
- Automatic fallback between data sources
- Comprehensive error handling and retry logic
- Health monitoring and alerting

### Performance Optimization
- Multi-level caching (30s for prices, 60s for pools)
- Rate limit management and request throttling
- Batch processing for multiple token queries
- Efficient memory usage and cleanup

### Market Intelligence
- Volatility analysis and classification
- Sentiment assessment from price action
- Liquidity scoring (0-10 scale)
- Risk level determination
- Portfolio exposure tracking

## Configuration

### Environment Variables (see `src/config/env-example.ts`)

```env
# API Keys
BIRDEYE_API_KEY=your_birdeye_api_key_here
COINGECKO_API_KEY=your_coingecko_api_key_here

# Rate Limiting
COINGECKO_RATE_LIMIT_PER_MINUTE=10
BIRDEYE_RATE_LIMIT_PER_MINUTE=100

# Cache Configuration
PRICE_CACHE_EXPIRY_SECONDS=30
POOL_CACHE_EXPIRY_SECONDS=60

# Circuit Breaker
CIRCUIT_BREAKER_FAILURE_THRESHOLD=5
CIRCUIT_BREAKER_TIMEOUT_MS=300000
```

### Service Configuration

```typescript
const priceFeedService = new PriceFeedService();
const marketDataManager = new MarketDataManager(priceFeedService);

// Start monitoring specific tokens
marketDataManager.startMonitoring(['token1', 'token2', 'token3']);
```

## Usage Examples

### Get Token Price
```typescript
const priceData = await priceFeedService.getTokenPrice(tokenAddress, symbol);
if (priceData) {
  console.log(`${priceData.symbol}: $${priceData.price}`);
  console.log(`Volume 24h: $${priceData.volume24h}`);
}
```

### Get Pool Liquidity
```typescript
const poolData = await priceFeedService.getPoolLiquidity(poolAddress);
if (poolData) {
  console.log(`Total Liquidity: $${poolData.totalLiquidityUsd}`);
  console.log(`24h Volume: $${poolData.volume24h}`);
}
```

### Market Condition Analysis
```typescript
const condition = marketDataManager.getMarketCondition(tokenAddress);
if (condition) {
  console.log(`Volatility: ${condition.volatility}`);
  console.log(`Recommended: ${condition.recommendedAction}`);
}
```

### Position Size Recommendation
```typescript
const recommendation = marketDataManager.getRecommendedPositionSize(
  tokenAddress,
  availableCapital,
  maxRiskPercent
);
console.log(`Recommended size: $${recommendation.recommendedSize}`);
```

## Monitoring & Health Checks

### Health Status Monitoring
```typescript
const monitor = new PriceFeedMonitor(priceFeedService);
const status = monitor.getHealthStatus();

console.log(`Overall health: ${status.overall}`);
console.log(`Success rate: ${status.performance.successRate}%`);
console.log(`Avg response: ${status.performance.avgResponseTime}ms`);
```

### Alerts and Notifications
The monitor automatically generates alerts for:
- Service unavailability
- High error rates
- Rate limit exhaustion
- Circuit breaker activation
- Performance degradation

## Performance Benefits

1. **Accurate Pricing**: Real market data instead of mock values
2. **Better Decisions**: Liquidity-aware trading strategies
3. **Risk Management**: Real-time market condition assessment
4. **High Availability**: Multiple data sources with fallbacks
5. **Optimal Performance**: Intelligent caching and rate limiting

## Error Handling

### Circuit Breaker Pattern
- Opens after 5 consecutive failures
- 5-minute timeout before retry attempts
- Automatic recovery on successful requests
- Graceful degradation to fallback sources

### Fallback Mechanisms
1. **Primary → Secondary**: Coingecko → Birdeye
2. **API → Cache**: Use cached data on API failures
3. **Real → Estimated**: Conservative estimates when all APIs fail
4. **Current → Historical**: Use last known good values

### Retry Logic
- Exponential backoff for temporary failures
- Different strategies per error type
- Maximum retry limits to prevent infinite loops
- Circuit breaker integration

## Testing

### Unit Tests
- Comprehensive test suite (`tests/unit/price-feed-service.test.ts`)
- API mocking and error simulation
- Cache behavior validation
- Rate limiting verification

### Integration Tests
- End-to-end data flow testing
- Multi-service failure scenarios
- Performance benchmarking
- Real API integration testing

## Migration from Mock Data

### Before (Mock Implementation)
```typescript
// Lines 366+ in strategy-engine.ts
return {
  totalLiquidityUsd: Math.random() * 50000 + 1000, // Mock data
  tokenAReserve: Math.random() * 1000000,
  tokenBReserve: Math.random() * 1000000,
  priceRatio: Math.random() * 0.01 + 0.0001,
};
```

### After (Real Data Integration)
```typescript
// Real pool data from Birdeye API
const poolData = await this.priceFeedService.getPoolLiquidity(poolAddress);
return {
  totalLiquidityUsd: poolData.totalLiquidityUsd,
  tokenAReserve: poolData.tokenA.reserve,
  tokenBReserve: poolData.tokenB.reserve,
  priceRatio: poolData.priceRatio,
  volume24h: poolData.volume24h,
};
```

## Future Enhancements

### Planned Features
- Additional data sources (Dexscreener, CoinMarketCap)
- Machine learning price prediction
- Advanced technical indicators
- Social sentiment integration
- Cross-chain price aggregation

### Performance Optimizations
- GraphQL query optimization
- Database query caching
- Compressed data storage
- Edge caching with CDN

### Monitoring Enhancements
- Real-time dashboards
- Predictive alerting
- Performance analytics
- Cost optimization tracking

## Troubleshooting

### Common Issues

1. **API Key Errors**
   - Verify API keys in environment variables
   - Check API key permissions and limits
   - Ensure keys are not expired

2. **Rate Limiting**
   - Reduce request frequency
   - Upgrade API plan if needed
   - Implement request queuing

3. **High Response Times**
   - Check network connectivity
   - Consider RPC endpoint changes
   - Monitor API service status

4. **Cache Misses**
   - Verify cache configuration
   - Monitor memory usage
   - Adjust cache expiry times

### Debug Logging
Enable verbose logging to troubleshoot issues:
```typescript
const logger = new Logger('PriceFeed', { verbose: true });
```

### Health Check Commands
```bash
# Check service status
curl http://localhost:3000/api/health/price-feed

# Get performance metrics
curl http://localhost:3000/api/metrics/price-feed

# View current alerts
curl http://localhost:3000/api/alerts/price-feed
```

## Support and Maintenance

### Regular Tasks
- Monitor API usage and costs
- Update API keys before expiration
- Review and optimize cache settings
- Analyze performance metrics
- Update fallback data sources

### Performance Monitoring
- Track response times and error rates
- Monitor cache hit ratios
- Analyze trading decision accuracy
- Review portfolio performance impact

This integration provides a robust, scalable foundation for real-time market data in the liquid-snipe trading bot, replacing unreliable mock data with production-grade market intelligence.
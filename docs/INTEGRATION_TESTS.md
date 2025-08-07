# Integration Tests Guide

This document outlines the comprehensive integration test suite for the liquid-snipe trading bot MVP. The integration tests validate real blockchain operations and external API integrations while maintaining safety through devnet usage and dry-run modes.

## Test Suite Overview

### Test Categories

1. **Jupiter DEX Integration** (`jupiter-integration.test.ts`)
   - Real Jupiter API quote fetching
   - Swap transaction building (without submission)
   - Slippage protection validation
   - Price impact calculations
   - Error scenarios (rate limits, insufficient liquidity)

2. **Market Data Integration** (`market-data-integration.test.ts`)
   - CoinGecko API integration with rate limiting
   - Birdeye API for Solana token data
   - Real-time data processing and caching
   - API fallback mechanisms
   - Circuit breaker patterns

3. **Wallet Operations** (`wallet-operations.test.ts`)
   - Keypair generation and secure storage
   - SPL token account management
   - Hardware wallet simulation
   - Balance queries and validation
   - Transaction building and signing

4. **End-to-End Trading** (`end-to-end-trading.test.ts`)
   - Complete trading flow simulation
   - Position management lifecycle
   - Exit strategy execution
   - Risk management validation
   - Error recovery scenarios

5. **Performance Testing** (`performance-integration.test.ts`)
   - Real-time data processing latency
   - Concurrent operation scaling
   - Memory usage under load
   - Database performance with large datasets
   - Network resilience testing

6. **Error Scenarios** (`error-scenarios.test.ts`)
   - Network failure recovery
   - API service outages
   - Database corruption handling
   - Transaction failure scenarios
   - Resource exhaustion testing

## Prerequisites

### Required Dependencies

```bash
npm install --save-dev nock @solana/spl-token
```

### Environment Setup

1. **Devnet Access**: Tests use Solana devnet for blockchain operations
2. **API Keys**: External APIs are mocked, no real API keys needed
3. **File Permissions**: Tests create temporary files in `/tmp/`
4. **Network Access**: Required for devnet connectivity

### Test Data

- **Mock Data**: Located in `tests/test-fixtures/`
- **Test Keypairs**: Predefined keypairs for consistent testing
- **API Responses**: Realistic mock responses for external services

## Running Tests

### Basic Commands

```bash
# Run all tests
npm test

# Run only unit tests
npm run test:unit

# Run only integration tests
npm run test:integration

# Run integration tests with watch mode
npm run test:integration:watch

# Run with coverage report
npm run test:coverage

# CI/CD optimized run
npm run test:ci
```

### Individual Test Files

```bash
# Run specific integration test
npx jest tests/integration/jupiter-integration.test.ts

# Run with verbose output
npx jest tests/integration/wallet-operations.test.ts --verbose

# Run performance tests with custom timeout
npx jest tests/integration/performance-integration.test.ts --testTimeout=120000
```

## Test Configuration

### Jest Setup

The project uses a multi-project Jest configuration:

- **Unit Tests**: Fast, isolated tests with mocked dependencies
- **Integration Tests**: Longer-running tests with real network calls
- **Custom Sequencer**: Optimizes test execution order
- **Global Setup/Teardown**: Manages test environment lifecycle

### Timeout Configuration

- **Unit Tests**: 30 seconds (default)
- **Integration Tests**: 60 seconds
- **Performance Tests**: 120 seconds for stress testing
- **Network Tests**: Variable based on connection quality

### Coverage Thresholds

- **Global**: 75% branches, 80% functions/lines/statements
- **Core Components**: 85% branches, 90% functions/lines/statements  
- **Security Components**: 90% branches, 95% functions/lines/statements

## Safety Measures

### Always Dry Run

All integration tests run in **dry-run mode** to prevent:
- Accidental mainnet transactions
- Real fund usage
- Unintended trading activity

### Devnet Only

Blockchain operations use **Solana devnet**:
- Safe testing environment
- No real SOL at risk
- Realistic blockchain behavior
- Free devnet SOL from faucets

### Mock External APIs

External services are mocked to:
- Avoid API rate limits during testing
- Ensure consistent test results
- Test error scenarios safely
- Reduce test dependencies

## Test Execution Flow

### 1. Global Setup
- Create temporary directories
- Verify devnet connectivity  
- Initialize test utilities
- Set environment variables

### 2. Test Sequencing
Tests run in optimized order:
1. Wallet operations (foundation)
2. Jupiter integration (core DEX)
3. Market data integration (APIs)
4. End-to-end trading (workflows)
5. Performance testing (load)
6. Error scenarios (edge cases)

### 3. Global Teardown
- Clean temporary files
- Close connections
- Generate reports
- Restore environment

## Debugging Integration Tests

### Verbose Logging

```bash
# Enable debug logging
LOG_LEVEL=debug npm run test:integration

# Test-specific logging
DEBUG=true npx jest tests/integration/jupiter-integration.test.ts
```

### Network Issues

```bash
# Test devnet connectivity
curl -X POST https://api.devnet.solana.com \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'

# Check test network setup
node -e "console.log(require('os').networkInterfaces())"
```

### File System Issues

```bash
# Check temporary directory permissions
ls -la /tmp/liquid-snipe-test/

# Clean up test artifacts
rm -rf /tmp/liquid-snipe-test/
rm -f /tmp/*test*keypair*.json
```

## Performance Benchmarks

### Expected Performance Metrics

| Test Category | Average Latency | Throughput | Error Rate |
|---------------|----------------|------------|------------|
| Pool Events | <100ms | >10 ops/sec | <5% |
| Price Updates | <10ms | >100 ops/sec | 0% |
| DB Operations | <5ms | >200 ops/sec | 0% |
| Network Calls | <1000ms | >5 ops/sec | <10% |

### Resource Limits

- **Memory**: <200MB increase during stress tests
- **CPU**: Graceful degradation under load
- **Network**: Resilient to devnet latency variations
- **Storage**: Efficient cleanup of temporary files

## Common Issues & Solutions

### 1. Network Timeouts

**Problem**: Tests fail due to devnet connectivity issues

**Solution**:
```bash
# Increase timeout for network-dependent tests
export TEST_NETWORK_TIMEOUT=30000
npm run test:integration
```

### 2. Rate Limiting

**Problem**: External API rate limits during development

**Solution**: All external APIs are mocked in tests. Real API calls only occur if mocks are disabled.

### 3. File Permission Errors

**Problem**: Cannot create temporary test files

**Solution**:
```bash
# Ensure temp directory is writable
chmod 755 /tmp/
mkdir -p /tmp/liquid-snipe-test/
chmod 755 /tmp/liquid-snipe-test/
```

### 4. Memory Issues

**Problem**: Tests consume excessive memory

**Solution**:
```bash
# Run tests with increased memory
node --max-old-space-size=4096 node_modules/.bin/jest --selectProjects integration
```

### 5. Database Locks

**Problem**: SQLite database locked during tests

**Solution**: Tests use `:memory:` databases by default. If using file databases, ensure proper cleanup.

## Contributing

### Adding New Integration Tests

1. Create test file in `tests/integration/`
2. Follow naming convention: `feature-integration.test.ts`
3. Include comprehensive error scenarios
4. Add performance benchmarks where applicable
5. Update this documentation

### Test Data Management

- Add mock data to `tests/test-fixtures/`
- Use realistic but safe values
- Document data relationships
- Provide multiple scenarios (success/error/edge cases)

### Performance Considerations

- Mock external services by default
- Use devnet for blockchain operations only
- Implement proper timeouts
- Clean up resources in `afterEach`/`afterAll`
- Monitor memory usage in long-running tests

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Integration Tests

on: [push, pull_request]

jobs:
  integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '18'
          cache: 'npm'
      
      - run: npm ci
      - run: npm run test:ci
      
      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          files: ./coverage/lcov.info
```

### Docker Support

```dockerfile
# Test container
FROM node:18-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=dev

COPY . .
CMD ["npm", "run", "test:integration"]
```

## Security Considerations

### Test Isolation

- Each test uses unique identifiers
- Temporary files are isolated
- No shared state between tests
- Cleanup is guaranteed

### Data Protection

- No real private keys in test code
- Mock keypairs only for testing
- Sensitive data is never logged
- Test artifacts are cleaned up

### Network Security

- Only devnet connections allowed
- No mainnet operations possible
- API mocking prevents external data leakage
- Rate limiting protects against abuse

---

For questions or issues with integration tests, please refer to the main project README or create an issue in the repository.
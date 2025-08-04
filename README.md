# 🎯 Liquid-Snipe

[![TypeScript](https://img.shields.io/badge/typescript-%23007ACC.svg?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Solana](https://img.shields.io/badge/Solana-9945FF?style=for-the-badge&logo=solana&logoColor=white)](https://solana.com/)
[![MIT License](https://img.shields.io/badge/License-MIT-green.svg?style=for-the-badge)](https://choosealicense.com/licenses/mit/)
[![Node.js](https://img.shields.io/badge/node.js-6DA55F?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Jest](https://img.shields.io/badge/-jest-%23C21325?style=for-the-badge&logo=jest&logoColor=white)](https://jestjs.io/)

> **Advanced Solana trading bot that monitors DEXes for new liquidity pools and executes automated trades with sophisticated exit strategies.**

Liquid-Snipe is a high-performance, feature-rich trading bot designed for the Solana blockchain ecosystem. It automatically detects new liquidity pool creations across multiple DEXes, evaluates trading opportunities based on configurable criteria, and manages positions using advanced exit strategies including trailing stops, volatility-based exits, and multi-condition logic.

## ✨ Features

### 🔍 **Real-Time Pool Monitoring**
- Monitors multiple DEXes simultaneously (Raydium, Orca, Jupiter)
- Real-time blockchain event tracking via WebSocket connections
- Configurable pool filtering and token validation
- Anti-rug pull protection with creator wallet monitoring

### 🧠 **Advanced Exit Strategies**
- **Multi-Condition Exits**: Combine multiple exit conditions with AND/OR logic
- **Trailing Stop Loss**: Dynamic stop prices that follow profitable moves
- **Volatility-Based Stops**: Adaptive stop losses based on market volatility
- **Volume-Based Exits**: Exit on unusual volume spikes or drops
- **Partial Exits**: Staged position closing for risk management
- **Time-Based Exits**: Automatic position closure after specified periods

### 📊 **Comprehensive Analysis**
- Price trend detection using moving averages and momentum
- Volume pattern analysis with spike/drop detection
- Volatility calculations and risk assessment
- Creator activity monitoring (placeholder)
- Sentiment analysis framework (placeholder)

### 🖥️ **Professional TUI Interface**
- Real-time dashboard with live updates
- Position tracking and P&L monitoring
- Interactive command system
- System status and error reporting
- Customizable display layouts

### 🛡️ **Risk Management**
- Portfolio-level risk controls
- Per-trade risk percentage limits
- Slippage protection
- Gas fee optimization
- Circuit breaker patterns for error recovery

### 📁 **Data Management**
- SQLite database for all trading data
- Comprehensive logging and audit trails
- Event history and replay capabilities
- Performance analytics and reporting
- Automated data backup and cleanup

## Quick Start

### Prerequisites

- Node.js 18+
- A Solana wallet with SOL for trading
- RPC endpoint (Alchemy, QuickNode, or public)

### Installation

```bash
# Clone the repository
git clone https://github.com/dylan-gluck/liquid-snipe.git
cd liquid-snipe

# Install dependencies
pnpm install

# Build the project
pnpm build
```

### Configuration

1. **Create your wallet keypair:**
```bash
mkdir keys
# Place your wallet keypair JSON file in keys/trading-wallet.json
```

2. **Configure the bot:**
```bash
# Copy example configuration
cp config.example.yaml config.yaml

# Edit configuration with your settings
nano config.yaml
```

3. **Set environment variables:**
```bash
cp .env.example .env
# Add your RPC endpoints and API keys
```

### Running the Bot

```bash
# Development mode with hot reload
pnpm dev

# Production mode
pnpm start

# Dry run mode (monitoring only, no trading)
pnpm start -- --dry-run

# With custom configuration
pnpm start -- --config ./my-config.yaml

# Console mode (no TUI)
pnpm start -- --disable-tui
```

## 📖 Configuration

### Basic Configuration

```yaml
# Trading parameters
tradeConfig:
  minLiquidityUsd: 1000
  defaultTradeAmountUsd: 100
  maxSlippagePercent: 2
  maxHoldingTimeMinutes: 1440

# Risk management
wallet:
  riskPercent: 5  # Max 5% of wallet per trade
  maxTotalRiskPercent: 20  # Max 20% total exposure

# Exit strategies
exitStrategies:
  - type: "profit"
    enabled: true
    params:
      profitPercentage: 50
      trailingStopPercent: 5

  - type: "trailing-stop"
    enabled: false
    params:
      initialStopPercent: 15
      trailPercent: 10
      activationPercent: 20
```

### Advanced Exit Strategies

```yaml
exitStrategies:
  # Multi-condition strategy
  - type: "multi-condition"
    enabled: false
    params:
      operator: "OR"  # AND | OR
      priority: "HIGHEST_URGENCY"
      conditions:
        - type: "profit"
          enabled: true
          params:
            profitPercentage: 30
        - type: "trailing-stop"
          enabled: true
          params:
            initialStopPercent: 20
            trailPercent: 15

  # Partial exit strategy
  - type: "partial-exit"
    enabled: false
    params:
      stages:
        - triggerCondition:
            type: "profit"
            params:
              profitPercentage: 25
          exitPercentage: 30
        - triggerCondition:
            type: "profit"
            params:
              profitPercentage: 50
          exitPercentage: 50

  # Volatility-based stop loss
  - type: "volatility-stop"
    enabled: false
    params:
      baseStopPercent: 15
      volatilityMultiplier: 0.5
      lookbackPeriodMinutes: 30
      minStopPercent: 10
      maxStopPercent: 25

  # Volume-based exit
  - type: "volume-based"
    enabled: false
    params:
      minVolumeUsd: 1000
      volumeDropThresholdPercent: 70
      lookbackPeriodMinutes: 15
      exitOnVolumeSpike: true
      volumeSpikeMultiplier: 5
```

### Command Line Options

```bash
# Trading Configuration
--amount <usd>              # Trade amount in USD (default: 100)
--max-amount <usd>          # Maximum trade amount
--risk <percent>            # Risk percentage per trade (default: 5)
--min-liquidity <usd>       # Minimum pool liquidity threshold
--max-slippage <percent>    # Maximum acceptable slippage

# DEX Configuration
--enable-dex <name>         # Enable specific DEX (Raydium, Orca)
--disable-dex <name>        # Disable specific DEX

# Connection Configuration
--rpc <url>                 # Custom RPC endpoint
--keypair <path>            # Custom keypair file path

# Exit Strategy
--strategy <name>           # Use specific exit strategy

# Operational Modes
--dry-run                   # Monitor only, no trading
--disable-tui               # Run without text UI
--verbose                   # Enable detailed logging

# Utilities
--help                      # Show all options
export-config <file>        # Export default config
validate-config <file>      # Validate configuration
```

## Architecture

### System Components

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  Configuration  │    │  Core Controller│    │      TUI        │
│     Manager     │◄───┤                 ├───►│   Controller    │
└─────────────────┘    └─────────┬───────┘    └─────────────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        │                        │                        │
        ▼                        ▼                        ▼
┌─────────────┐    ┌─────────────────┐    ┌─────────────────┐
│ Blockchain  │    │  Strategy       │    │  Position       │
│  Watcher    │    │  Engine         │    │  Manager        │
└─────────────┘    └─────────────────┘    └─────────────────┘
        │                        │                        │
        ▼                        ▼                        ▼
┌─────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Event     │    │  Trade          │    │   Database      │
│  Manager    │    │  Executor       │    │   Manager       │
└─────────────┘    └─────────────────┘    └─────────────────┘
```

### Key Components

- **Core Controller** - Orchestrates all system components and manages application lifecycle
- **Blockchain Watcher** - Monitors Solana blockchain for new liquidity pool events
- **Strategy Engine** - Evaluates trading opportunities using configurable strategies
- **Trade Executor** - Executes trades with security validation and error handling
- **Position Manager** - Tracks open positions and manages exit strategies
- **Event Manager** - Centralized event system with persistence and notifications
- **Database Manager** - SQLite-based data persistence for all trading data

## Trading Strategies

### Exit Strategies

The bot supports multiple exit strategies that can be combined:

#### Profit-based Exit
```yaml
- type: "profit"
  params:
    profitPercentage: 50  # Exit when 50% profit reached
```

#### Time-based Exit
```yaml
- type: "time"
  params:
    timeMinutes: 60       # Exit after 1 hour
```

#### Loss-based Exit (Stop Loss)
```yaml
- type: "loss"
  params:
    lossPercentage: 20    # Exit at 20% loss
```

#### Liquidity-based Exit
```yaml
- type: "liquidity"
  params:
    minLiquidityUsd: 1000 # Exit if liquidity drops below $1000
    percentOfInitial: 50   # Or drops to 50% of initial
```

#### Developer Activity Exit
```yaml
- type: "developer-activity"
  params:
    monitorDeveloperWallet: true
    exitOnSellPercentage: 10  # Exit if dev sells 10% of holdings
```

## Development

### Development Environment

```bash
# Install dependencies
pnpm install

# Run in development mode with hot reloading
pnpm dev

# Run TypeScript type checking
pnpm typecheck

# Run linter
pnpm lint

# Auto-fix linting issues
pnpm lint:fix

# Format code
pnpm format
```

### Testing

```bash
# Run all tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Run specific test suites
pnpm test -- -t "ConfigManager"
pnpm test -- -t "EventManager"
pnpm test -- -t "PositionManager"

# View test coverage
open coverage/lcov-report/index.html
```

### Project Structure

```
src/
├── blockchain/          # Blockchain interaction components
│   ├── blockchain-watcher.ts
│   ├── connection-manager.ts
│   ├── token-info-service.ts
│   └── solana-utils.ts
├── config/             # Configuration management
│   ├── config-manager.ts
│   ├── default.ts
│   └── index.ts
├── core/               # Core application logic
│   └── controller.ts
├── db/                 # Database models and operations
│   └── models/
├── events/             # Event system
│   ├── event-manager.ts
│   ├── event-logger.ts
│   └── notification-broadcaster.ts
├── trading/            # Trading logic
│   ├── position-manager.ts
│   ├── strategy-engine.ts
│   └── trade-executor.ts
├── types/              # TypeScript type definitions
├── utils/              # Utility functions
└── index.ts           # Application entry point
```

## Database Schema

The bot uses SQLite for data persistence with the following main tables:

- **tokens** - Token metadata and verification status
- **liquidity_pools** - DEX pool information and liquidity tracking
- **trades** - Individual buy/sell transactions
- **positions** - Open/closed trading positions with P&L
- **log_events** - Application logs and event history

## Security Considerations

- Wallet private keys should be stored securely
- Use hardware wallets for production deployments
- Enable transaction simulation before execution
- Configure appropriate risk limits
- Monitor for MEV attacks and sandwich attacks
- Regular security audits recommended

## Monitoring and Alerting

The bot includes comprehensive logging and can be extended with:

- Discord/Telegram notifications
- Performance metrics collection
- Health checks and diagnostics
- Custom alerting rules

## Troubleshooting

### Common Issues

1. **RPC Connection Errors**
   - Verify RPC endpoint is accessible
   - Check for rate limiting
   - Consider using premium RPC providers

2. **Transaction Failures**
   - Ensure sufficient SOL for gas fees
   - Check slippage tolerance settings
   - Verify wallet has required permissions

3. **Configuration Errors**
   - Validate configuration with `validate-config`
   - Check file paths and permissions
   - Verify DEX program IDs are current

### Debug Mode

```bash
# Enable verbose logging
pnpm start -- --verbose

# Run with debug output
DEBUG=* pnpm start
```

## Roadmap

- [ ] Advanced ML-based token analysis
- [ ] Multi-chain support (Ethereum, BSC)
- [ ] Web dashboard interface
- [ ] Advanced portfolio optimization
- [ ] Integration with additional DEXes
- [ ] Mobile app for monitoring

## Contributing

Contributions are welcome! Please see our contributing guidelines:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Guidelines

- Follow TypeScript best practices
- Add tests for new features
- Update documentation as needed
- Run linting and type checking before commits
- Follow conventional commit messages

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Disclaimer

**⚠️ Important Warning**

This software is for educational and research purposes only. Trading cryptocurrencies involves substantial risk of loss and is not suitable for all investors. The authors and contributors are not responsible for any financial losses incurred through the use of this software.

- Never invest more than you can afford to lose
- Thoroughly test on devnet before mainnet deployment
- Understand the risks of automated trading
- Consider the tax implications in your jurisdiction
- This software comes with no warranty or guarantee

## Support

- 📖 [Documentation](docs/)
- 🐛 [Issue Tracker](https://github.com/dylan-gluck/liquid-snipe/issues)
- 💬 [Discussions](https://github.com/dylan-gluck/liquid-snipe/discussions)

---

**Built with ❤️ for the Solana DeFi ecosystem**

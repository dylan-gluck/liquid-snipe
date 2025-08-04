# Liquid-Snipe

[![Build Status](https://img.shields.io/badge/build-passing-brightgreen.svg)](https://github.com/dylan-gluck/liquid-snipe)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3.3-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20.x-green.svg)](https://nodejs.org/)
[![Solana](https://img.shields.io/badge/Solana-Compatible-purple.svg)](https://solana.com/)

> 🎯 **Advanced Solana Trading Bot** - Automated DeFi trading system that monitors new liquidity pools and executes intelligent trades with comprehensive risk management.

## Overview

Liquid-Snipe is a sophisticated, event-driven trading bot designed for the Solana blockchain. It automatically monitors DEX platforms for new liquidity pool creation events, analyzes emerging tokens using configurable strategies, and executes trades with built-in risk management and position tracking.

### Key Features

- **🔍 Real-time DEX Monitoring** - Tracks new liquidity pools across multiple Solana DEX platforms
- **🧠 Intelligent Strategy Engine** - Configurable trading strategies with risk assessment
- **💰 Position Management** - Comprehensive tracking with multiple exit strategies
- **⚡ Event-Driven Architecture** - Modular, scalable system design
- **🛡️ Risk Management** - Built-in safety controls and circuit breakers
- **📊 TUI Interface** - Text-based user interface for monitoring and control
- **🗄️ SQLite Database** - Persistent storage for trades, positions, and analytics
- **🔧 Flexible Configuration** - YAML/JSON config with CLI overrides

## Quick Start

### Prerequisites

- Node.js 20.x or higher
- pnpm package manager
- Solana wallet keypair
- RPC endpoint access

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

### Basic Configuration

```bash
# Export default configuration template
pnpm start -- export-config config.yaml

# Edit the configuration file with your settings
# - Set your RPC endpoint
# - Configure wallet keypair path
# - Adjust trading parameters
# - Select exit strategies

# Validate your configuration
pnpm start -- validate-config config.yaml
```

### Running the Bot

```bash
# Start with default configuration
pnpm start

# Use custom configuration file
pnpm start -- --config config.yaml

# Run in dry-run mode (monitor only, no trading)
pnpm start -- --dry-run

# Start with specific trading parameters
pnpm start -- --amount 100 --risk 5 --min-liquidity 2000
```

## Configuration

### Configuration File Structure

```yaml
rpc:
  httpUrl: "https://api.mainnet-beta.solana.com"
  wsUrl: "wss://api.mainnet-beta.solana.com"

wallet:
  keypairPath: "./keys/trading-wallet.json"
  riskPercent: 5

trading:
  defaultAmountUsd: 100
  maxAmountUsd: 1000
  minLiquidityUsd: 1000
  maxSlippagePercent: 2

dexes:
  raydium:
    enabled: true
    programId: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
  orca:
    enabled: true
    programId: "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP"

exitStrategies:
  - name: "Default Profit Strategy"
    conditions:
      - type: "profit"
        params:
          profitPercentage: 50
      - type: "time"
        params:
          timeMinutes: 60
      - type: "loss"
        params:
          lossPercentage: 20
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
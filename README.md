# Liquid-Snipe

A Solana trading bot that monitors for new liquidity pools being created on DEXes, automatically executes trades to take long positions on promising new tokens, and manages those positions according to configurable exit strategies.

## Features

- Monitor Solana blockchain for new liquidity pool creation events
- Filter and analyze new tokens based on configurable criteria
- Execute automated trades with risk management controls
- Track positions and implement various exit strategies
- Provide a comprehensive TUI for monitoring and control
- Store all relevant data in a SQLite database for analysis and review

## Project Status

This project is under active development. Currently implemented:

- ✅ Comprehensive configuration system with YAML/JSON support
- ✅ Command-line interface with extensive options
- ✅ Flexible exit strategy framework
- ✅ Multi-DEX support infrastructure
- ✅ Database schema and operations
- ⏳ Blockchain monitoring (in progress)
- ⏳ Trading logic (in progress)
- ⏳ User interface (in progress)

## Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/liquid-snipe.git
cd liquid-snipe

# Install dependencies
npm install

# Build the project
npm run build
```

## Configuration

You can configure Liquid-Snipe in several ways:

### Using YAML or JSON files

An example configuration file is provided:

```bash
# Export the default configuration to a YAML file
npm start -- export-config my-config.yaml

# Edit the file with your settings, then use it
npm start -- --config my-config.yaml

# Validate a configuration file
npm start -- validate-config my-config.yaml
```

### Using environment variables

Copy the example environment file and modify it:

```bash
cp .env.example .env
```

### Using command-line arguments

```bash
# Basic usage examples
npm start -- --dry-run                        # Monitor only mode (no trading)
npm start -- --verbose                        # Enable verbose logging
npm start -- --disable-tui                    # Run without TUI (console logs only)

# Trading configuration
npm start -- --amount 200                     # Set trade amount to $200
npm start -- --max-amount 1000                # Set maximum trade amount to $1000
npm start -- --risk 5                         # Set risk percentage to 5%
npm start -- --min-liquidity 2000             # Only trade pools with $2000+ liquidity
npm start -- --max-slippage 2                 # Set maximum slippage to 2%

# DEX configuration
npm start -- --enable-dex Raydium             # Enable Raydium DEX
npm start -- --enable-dex Orca                # Enable Orca DEX
npm start -- --disable-dex Raydium            # Disable Raydium DEX

# Connection configuration
npm start -- --rpc https://my-rpc.example.com # Set custom RPC endpoint
npm start -- --keypair ./path/to/keypair.json # Set custom keypair path

# Exit strategy configuration
npm start -- --strategy "Default Profit Strategy" # Use specific exit strategy

# Help and information
npm start -- --help                           # Show all available options
```

## Development

```bash
# Run in development mode with hot reloading
npm run dev

# Run tests
npm test

# Run specific tests
npm test -- -t "ConfigManager"

# Run tests in watch mode
npm run test:watch

# Run linter
npm run lint

# Fix linting issues
npm run lint:fix

# Run TypeScript type checking
npm run typecheck
```

## Contributing

Contributions are welcome! Please feel free to submit a pull request.

## License

[MIT](LICENSE)
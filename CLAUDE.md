# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Development Commands

### Development and Testing
- `pnpm dev` - Run in development mode with hot reloading (uses ts-node)
- `pnpm test` - Run all tests with Jest
- `pnpm test:watch` - Run tests in watch mode
- `pnpm test -- -t "ConfigManager"` - Run specific tests by name pattern

### Build and Quality
- `pnpm build` - Compile TypeScript to JavaScript in `dist/` directory
- `pnpm typecheck` - Run TypeScript type checking without emitting files
- `pnpm lint` - Run ESLint on all TypeScript files in src/
- `pnpm lint:fix` - Run ESLint with auto-fix enabled
- `pnpm format` - Format code with Prettier

### Application Commands
- `pnpm start` - Run the compiled application
- `pnpm start -- --help` - Show all CLI options
- `pnpm start -- --dry-run` - Run in monitor-only mode (no trading)
- `pnpm start -- --config config.yaml` - Use custom configuration file
- `pnpm start -- export-config config.yaml` - Export current config to file
- `pnpm start -- validate-config config.yaml` - Validate a configuration file

## Architecture Overview

This is a Solana trading bot that monitors DEXes for new liquidity pools and executes automated trades. The application is built with a modular event-driven architecture.

### Core Components

**Application Entry Point (`src/index.ts`)**
- CLI interface built with Commander.js
- Extensive command-line options for configuration overrides
- Configuration validation and loading
- Application lifecycle management

**Core Controller (`src/core/controller.ts`)**
- Central orchestrator for the entire application
- Manages initialization sequence and graceful shutdown
- Coordinates between different subsystems
- Handles process signals and error recovery

**Configuration System (`src/config/`)**
- Flexible config loading from YAML, JSON, environment variables, and CLI args
- Deep merge functionality for configuration overrides
- Comprehensive validation with detailed error messages
- Support for DEX enable/disable and exit strategy management

**Event System (`src/events/`)**
- Centralized event management with typed events
- Event persistence to database with configurable filtering
- Statistics tracking and error handling
- Support for sync/async event handlers

**Database Layer (`src/db/`)**
- SQLite-based data persistence
- Models for tokens, pools, trades, positions, and logs
- Automatic database initialization and migration
- Event logging with configurable retention

### Key Data Types

The application uses comprehensive TypeScript types defined in `src/types/index.ts`:

- **Configuration Types**: `AppConfig`, `DexConfig`, `WalletConfig`, `TradeConfig`, `ExitStrategyConfig`
- **Event Types**: `NewPoolEvent`, `TradeDecision`, `TradeResult`
- **Database Entities**: `Token`, `LiquidityPool`, `Trade`, `Position`, `LogEvent`

### Configuration Management

Configuration follows a hierarchical merge pattern:
1. Default configuration (`src/config/default.ts`)
2. File-based config (YAML/JSON)
3. Environment variables (prefixed with `LIQUID_SNIPE_`)
4. Command-line arguments

The ConfigManager provides methods for DEX management, exit strategy selection, and runtime configuration validation.

### Event-Driven Architecture

The application uses a centralized EventManager that:
- Provides type-safe event subscription and emission
- Automatically persists events to database (configurable)
- Tracks statistics and handles errors gracefully
- Supports both one-time and persistent subscriptions

Events flow through the system to coordinate between monitoring, decision-making, trading, and position management components.

### Database Schema

Uses SQLite with models for:
- `tokens` - Token metadata and verification status
- `liquidity_pools` - DEX pool information and liquidity tracking
- `trades` - Individual buy/sell transactions
- `positions` - Open/closed trading positions with P&L
- `log_events` - Application logs and event history

## Development Notes

- The application is currently under development with blockchain monitoring and trading logic marked as TODO
- Uses comprehensive error handling with graceful shutdown procedures
- Supports both TUI and console-only modes for different deployment scenarios
- All database operations are async and use proper connection management
- Configuration validation prevents invalid states at startup

## Development Conventions

### Testing and Validation
- Always run tests after making changes: `pnpm test`
- Run type checking before committing: `pnpm typecheck`
- Run linting and fix issues: `pnpm lint:fix`
- Use `pnpm test -- -t "TestName"` to run specific tests during development

### Progress Tracking
- Always update TODO.md when completing tasks or identifying new work
- Mark completed items and add new tasks discovered during implementation
- Keep TODO.md current to track project progress and next steps

### Git Workflow
- Always commit changes after tests are passing
- Do not use emojis or credit claude, clean descriptive commit messages

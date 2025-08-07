/**
 * Environment variables configuration for Liquid-Snipe
 * Copy this file to .env and fill in your API keys and configuration
 */

// Solana RPC Configuration
export const SOLANA_RPC_HTTP_URL = 'https://api.mainnet-beta.solana.com';
export const SOLANA_RPC_WS_URL = 'wss://api.mainnet-beta.solana.com';

// Alternative RPC providers (uncomment to use)
// export const SOLANA_RPC_HTTP_URL = 'https://solana-mainnet.g.alchemy.com/v2/YOUR_ALCHEMY_API_KEY';
// export const SOLANA_RPC_WS_URL = 'wss://solana-mainnet.g.alchemy.com/v2/YOUR_ALCHEMY_API_KEY';

// export const SOLANA_RPC_HTTP_URL = 'https://rpc.helius.xyz/?api-key=YOUR_HELIUS_API_KEY';
// export const SOLANA_RPC_WS_URL = 'wss://rpc.helius.xyz/?api-key=YOUR_HELIUS_API_KEY';

// Market Data API Keys
export const BIRDEYE_API_KEY = 'your_birdeye_api_key_here';
export const COINGECKO_API_KEY = 'your_coingecko_api_key_here'; // Optional - for pro tier

// Wallet Configuration
export const WALLET_KEYPAIR_PATH = './keypair.json';

// Database Configuration
export const DATABASE_PATH = './data/liquid-snipe.db';

// Trading Configuration
export const DEFAULT_TRADE_AMOUNT_USD = 50;
export const MAX_TRADE_AMOUNT_USD = 500;
export const MIN_LIQUIDITY_USD = 10000;
export const MAX_SLIPPAGE_PERCENT = 5;
export const MAX_RISK_PERCENT = 2;
export const MAX_TOTAL_RISK_PERCENT = 10;

// Notification Configuration (Optional)
export const TELEGRAM_BOT_TOKEN = 'your_telegram_bot_token';
export const TELEGRAM_CHAT_ID = 'your_telegram_chat_id';
export const DISCORD_WEBHOOK_URL = 'your_discord_webhook_url';

// Rate Limiting Configuration
export const COINGECKO_RATE_LIMIT_PER_MINUTE = 10; // Free tier: 10-50 calls/min
export const BIRDEYE_RATE_LIMIT_PER_MINUTE = 100; // Adjust based on your plan

// WebSocket Configuration
export const WEBSOCKET_RECONNECT_INTERVAL_MS = 5000;
export const WEBSOCKET_MAX_RECONNECT_ATTEMPTS = 10;

// Cache Configuration
export const PRICE_CACHE_EXPIRY_SECONDS = 30;
export const POOL_CACHE_EXPIRY_SECONDS = 60;
export const TOKEN_CACHE_EXPIRY_MINUTES = 30;

// Risk Management
export const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5;
export const CIRCUIT_BREAKER_TIMEOUT_MS = 300000; // 5 minutes

// DEX Configuration
export const RAYDIUM_ENABLED = true;
export const ORCA_ENABLED = true;
export const JUPITER_ENABLED = true;
export const SERUM_ENABLED = false;

// Monitoring Configuration
export const HEALTH_CHECK_INTERVAL_MS = 60000; // 1 minute
export const MARKET_ANALYSIS_INTERVAL_MS = 30000; // 30 seconds

// Development Configuration
export const LOG_LEVEL = 'info'; // debug, info, warning, error
export const DRY_RUN = false; // Set to true for testing without real trades
export const VERBOSE_LOGGING = false;
export const DISABLE_TUI = false;
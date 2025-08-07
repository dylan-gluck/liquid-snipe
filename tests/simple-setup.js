// Simple test setup for unit tests to avoid complex global integration setup

// Set test environment
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';

// Mock sqlite3 to prevent native binding issues - THIS MUST BE FIRST
jest.mock('sqlite3', () => ({
  Database: jest.fn().mockImplementation(() => ({
    run: jest.fn((sql, params, callback) => callback && callback(null)),
    get: jest.fn((sql, params, callback) => callback && callback(null, null)),
    all: jest.fn((sql, params, callback) => callback && callback(null, [])),
    close: jest.fn((callback) => callback && callback(null)),
    serialize: jest.fn((callback) => callback && callback()),
    prepare: jest.fn(() => ({
      run: jest.fn((params, callback) => callback && callback(null)),
      finalize: jest.fn(),
    })),
  })),
  OPEN_READWRITE: 1,
  OPEN_CREATE: 4,
}));

// Mock blessed for TUI testing
jest.mock('blessed', () => ({
  screen: jest.fn(() => ({
    render: jest.fn(),
    destroy: jest.fn(),
    key: jest.fn(),
    append: jest.fn(),
    on: jest.fn(),
  })),
  box: jest.fn(() => ({
    setContent: jest.fn(),
    render: jest.fn(),
    on: jest.fn(),
  })),
  list: jest.fn(() => ({
    setItems: jest.fn(),
    render: jest.fn(),
    on: jest.fn(),
  })),
  table: jest.fn(() => ({
    setData: jest.fn(),
    render: jest.fn(),
    on: jest.fn(),
  })),
  textbox: jest.fn(() => ({
    setValue: jest.fn(),
    render: jest.fn(),
    on: jest.fn(),
  })),
}));

// Mock Solana Web3.js for trading tests
jest.mock('@solana/web3.js', () => ({
  ...jest.requireActual('@solana/web3.js'),
  Connection: jest.fn().mockImplementation(() => ({
    getBalance: jest.fn().mockResolvedValue(1000000000), // 1 SOL
    getTokenAccountsByOwner: jest.fn().mockResolvedValue({ value: [] }),
    getParsedTokenAccountsByOwner: jest.fn().mockResolvedValue({ value: [] }),
    getLatestBlockhash: jest.fn().mockResolvedValue({
      blockhash: 'test-blockhash',
      lastValidBlockHeight: 12345,
    }),
    sendTransaction: jest.fn().mockResolvedValue('test-signature'),
    confirmTransaction: jest.fn().mockResolvedValue({ value: { err: null } }),
  })),
}));
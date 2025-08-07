// Simplified setup for atomic tests
const mockBuffer = require('buffer').Buffer;

// Mock the problematic parts of @solana/web3.js
const mockBN = {
  toArrayLike: jest.fn().mockReturnValue(mockBuffer.alloc(32)),
  toNumber: jest.fn().mockReturnValue(0),
  toString: jest.fn().mockReturnValue('0'),
};

// Mock Buffer and BN global dependencies
global.Buffer = mockBuffer;
global.BN = jest.fn().mockImplementation(() => mockBN);

jest.mock('@solana/web3.js', () => {
  const mockBuffer = require('buffer').Buffer;
  return {
    Connection: jest.fn(),
    PublicKey: jest.fn().mockImplementation((value) => ({
      toString: () => value,
      toBase58: () => value,
      toBuffer: () => mockBuffer.from(value),
      equals: jest.fn().mockReturnValue(false),
    })),
    Keypair: {
      generate: jest.fn().mockReturnValue({
        publicKey: 'mock-pubkey',
        secretKey: mockBuffer.alloc(64),
      }),
    },
    LAMPORTS_PER_SOL: 1000000000,
    SystemProgram: {
      transfer: jest.fn(),
    },
    Transaction: jest.fn(),
    sendAndConfirmTransaction: jest.fn(),
  };
});

// Mock other dependencies
jest.mock('async-mutex', () => ({
  Mutex: jest.fn().mockImplementation(() => ({
    runExclusive: jest.fn().mockImplementation(async (fn) => await fn()),
  })),
}));

// Mock logger
jest.mock('../src/utils/logger', () => ({
  Logger: jest.fn().mockImplementation((name) => ({
    info: jest.fn(),
    debug: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  })),
}));

// Mock database
jest.mock('../src/db', () => ({
  DatabaseManager: jest.fn(),
}));

// Mock event processor
jest.mock('../src/events/types', () => ({
  EventProcessor: jest.fn(),
}));
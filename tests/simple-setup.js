// Simple setup for testing
const { Buffer } = require('buffer');

// Mock the problematic parts of @solana/web3.js
const mockBN = {
  toArrayLike: jest.fn().mockReturnValue(Buffer.alloc(32)),
  toNumber: jest.fn().mockReturnValue(0),
  toString: jest.fn().mockReturnValue('0'),
};

// Mock Buffer and BN global dependencies
global.Buffer = Buffer;
global.BN = jest.fn().mockImplementation(() => mockBN);

jest.mock('@solana/web3.js', () => {
  return {
    Connection: jest.fn(),
    PublicKey: jest.fn().mockImplementation((value) => ({
      toString: () => value,
      toBase58: () => value,
      toBuffer: () => Buffer.from(value),
      equals: jest.fn().mockReturnValue(false),
    })),
    Keypair: {
      generate: jest.fn().mockReturnValue({
        publicKey: 'mock-pubkey',
        secretKey: Buffer.alloc(64),
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

// Mock the @jup-ag/api module
jest.mock('@jup-ag/api', () => ({
  JupiterApi: jest.fn(),
  JupiterError: jest.fn(),
}));

// Mock axios
jest.mock('axios', () => ({
  create: jest.fn(() => ({
    get: jest.fn(),
    post: jest.fn(),
  })),
  get: jest.fn(),
  post: jest.fn(),
}));
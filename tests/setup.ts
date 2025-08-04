// Mock the problematic parts of @solana/web3.js
const mockBN = {
  toArrayLike: jest.fn().mockReturnValue(Buffer.alloc(32)),
  toNumber: jest.fn().mockReturnValue(0),
  toString: jest.fn().mockReturnValue('0'),
};

// Mock Buffer and BN global dependencies
(global as any).Buffer = Buffer;
(global as any).BN = jest.fn().mockImplementation(() => mockBN);

jest.mock('@solana/web3.js', () => {
  return {
    Connection: jest.fn(),
    PublicKey: jest.fn().mockImplementation((value) => ({
      toString: () => value,
      toBase58: () => value,
      toBuffer: () => Buffer.from(value),
      equals: jest.fn().mockReturnValue(false),
    })),
    Transaction: jest.fn(),
    SystemProgram: {
      programId: {
        toString: () => '11111111111111111111111111111111',
      },
    },
    LAMPORTS_PER_SOL: 1000000000,
  };
});
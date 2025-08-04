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
    Keypair: {
      generate: jest.fn().mockImplementation(() => ({
        publicKey: {
          toString: () => 'mock-public-key',
          toBase58: () => 'mock-public-key',
          toBuffer: () => Buffer.from('mock-public-key'),
          equals: jest.fn().mockReturnValue(false),
        },
        secretKey: new Uint8Array(64).fill(1),
      })),
      fromSeed: jest.fn().mockImplementation((seed) => ({
        publicKey: {
          toString: () => `mock-public-key-${Buffer.from(seed).toString('hex').slice(0, 8)}`,
          toBase58: () => `mock-public-key-${Buffer.from(seed).toString('hex').slice(0, 8)}`,
          toBuffer: () => Buffer.from(`mock-public-key-${Buffer.from(seed).toString('hex').slice(0, 8)}`),
          equals: jest.fn().mockImplementation((other) => other.toString() === `mock-public-key-${Buffer.from(seed).toString('hex').slice(0, 8)}`),
        },
        secretKey: new Uint8Array(64).fill(2),
      })),
      fromSecretKey: jest.fn().mockImplementation(() => ({
        publicKey: {
          toString: () => 'mock-from-secret-key',
          toBase58: () => 'mock-from-secret-key',
          toBuffer: () => Buffer.from('mock-from-secret-key'),
          equals: jest.fn().mockReturnValue(false),
        },
        secretKey: new Uint8Array(64).fill(3),
      })),
    },
    Transaction: jest.fn().mockImplementation(() => {
      const mockTransaction = {
        add: jest.fn().mockReturnThis(),
        serialize: jest.fn().mockReturnValue(Buffer.alloc(100)),
        partialSign: jest.fn().mockImplementation((keypair) => {
          // Add a signature when partialSign is called
          (mockTransaction.signatures as any[]).push({
            publicKey: keypair.publicKey,
            signature: Buffer.alloc(64, 1), // Mock signature
          });
        }),
        signatures: [] as any[],
        feePayer: null,
        recentBlockhash: null,
      };
      return mockTransaction;
    }),
    SystemProgram: {
      programId: {
        toString: () => '11111111111111111111111111111111',
      },
      transfer: jest.fn().mockImplementation(({ fromPubkey, toPubkey, lamports }) => ({
        keys: [
          { pubkey: fromPubkey, isSigner: true, isWritable: true },
          { pubkey: toPubkey, isSigner: false, isWritable: true },
        ],
        programId: { toString: () => '11111111111111111111111111111111' },
        data: Buffer.alloc(12),
      })),
    },
    LAMPORTS_PER_SOL: 1000000000,
  };
});
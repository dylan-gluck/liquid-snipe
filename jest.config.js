module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/', '<rootDir>/tests/'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  setupFilesAfterEnv: ['<rootDir>/tests/simple-setup.js'],
  transform: {
    '^.+\\.(ts|tsx)$': 'babel-jest',
    '^.+\\.(js|jsx)$': 'babel-jest',
  },
  collectCoverage: true,
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov'],
  
  // Test organization and configuration
  projects: [
    {
      displayName: 'unit',
      testMatch: ['<rootDir>/tests/**/*.test.ts'],
      testPathIgnorePatterns: ['<rootDir>/tests/integration/'],
      setupFilesAfterEnv: ['<rootDir>/tests/setup.ts']
    },
    {
      displayName: 'integration',
      testMatch: ['<rootDir>/tests/integration/**/*.test.ts'],
      setupFilesAfterEnv: ['<rootDir>/tests/simple-setup.js'],
      // Timeout configured globally
      globalSetup: '<rootDir>/tests/integration/setup-integration.js',
      globalTeardown: '<rootDir>/tests/integration/teardown-integration.js'
    }
  ],
  
  // Global test configuration
  testTimeout: 30000, // Default timeout increased for blockchain operations
  
  // Coverage configuration
  coverageThreshold: {
    global: {
      branches: 75,
      functions: 80,
      lines: 80,
      statements: 80
    },
    // Stricter requirements for core components
    'src/core/': {
      branches: 85,
      functions: 90,
      lines: 90,
      statements: 90
    },
    'src/trading/': {
      branches: 85,
      functions: 90,
      lines: 90,
      statements: 90
    },
    'src/security/': {
      branches: 90,
      functions: 95,
      lines: 95,
      statements: 95
    }
  },
  
  // Module resolution
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@tests/(.*)$': '<rootDir>/tests/$1'
  },
  
  // Additional configuration for integration tests
};
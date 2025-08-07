/**
 * Global setup for integration tests
 * 
 * This runs once before all integration tests to:
 * - Set up test environment variables
 * - Initialize shared resources
 * - Validate network connectivity
 * - Set up mock servers if needed
 */

const fs = require('fs').promises;
const path = require('path');

module.exports = async function setupIntegration() {
  console.log('🔧 Setting up integration test environment...');
  
  // Set test environment variables
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error'; // Reduce noise in tests
  process.env.DRY_RUN = 'true'; // Always dry run for safety
  
  // Create temporary directories for test files
  const tempDirs = [
    '/tmp/liquid-snipe-test',
    '/tmp/liquid-snipe-test/keypairs',
    '/tmp/liquid-snipe-test/databases'
  ];
  
  for (const dir of tempDirs) {
    try {
      await fs.mkdir(dir, { recursive: true });
      console.log(`✓ Created temp directory: ${dir}`);
    } catch (error) {
      console.warn(`⚠ Failed to create directory ${dir}:`, error.message);
    }
  }
  
  // Set up test keypair paths
  process.env.TEST_KEYPAIR_DIR = '/tmp/liquid-snipe-test/keypairs';
  process.env.TEST_DB_DIR = '/tmp/liquid-snipe-test/databases';
  
  // Test network connectivity to devnet
  try {
    const response = await fetch('https://api.devnet.solana.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getHealth'
      })
    });
    
    if (response.ok) {
      console.log('✓ Devnet connectivity verified');
    } else {
      console.warn('⚠ Devnet connectivity issues, some tests may fail');
    }
  } catch (error) {
    console.warn('⚠ Cannot reach devnet:', error.message);
    console.warn('  Integration tests will run in offline mode where possible');
  }
  
  // Set up test timeouts - Jest handles this through configuration
  // Store timeout info for reference but don't use jasmine directly
  global.__ORIGINAL_TIMEOUT__ = 30000; // Jest default
  
  console.log('✓ Test timeout configured via Jest configuration');
  
  // Set up global test utilities
  global.testUtils = {
    tempDir: '/tmp/liquid-snipe-test',
    keypairDir: '/tmp/liquid-snipe-test/keypairs',
    dbDir: '/tmp/liquid-snipe-test/databases',
    
    // Helper to create unique test identifiers
    createTestId: () => `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    
    // Helper to create test keypair path
    createKeypairPath: (testName) => {
      const sanitized = testName.replace(/[^a-zA-Z0-9]/g, '-');
      return path.join('/tmp/liquid-snipe-test/keypairs', `${sanitized}-keypair.json`);
    },
    
    // Helper to create test database path
    createDbPath: (testName) => {
      const sanitized = testName.replace(/[^a-zA-Z0-9]/g, '-');
      return path.join('/tmp/liquid-snipe-test/databases', `${sanitized}.db`);
    },
    
    // Helper to wait for condition
    waitFor: async (condition, timeout = 5000, interval = 100) => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (await condition()) {
          return true;
        }
        await new Promise(resolve => setTimeout(resolve, interval));
      }
      return false;
    }
  };
  
  console.log('✅ Integration test environment setup complete');
};
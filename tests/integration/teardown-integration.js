/**
 * Global teardown for integration tests
 * 
 * This runs once after all integration tests to:
 * - Clean up temporary files and directories
 * - Close any remaining connections
 * - Restore original environment settings
 * - Generate test reports
 */

const fs = require('fs').promises;
const path = require('path');

module.exports = async function teardownIntegration() {
  console.log('🧹 Cleaning up integration test environment...');
  
  // Restore original timeout
  if (typeof jasmine !== 'undefined' && global.__ORIGINAL_TIMEOUT__) {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = global.__ORIGINAL_TIMEOUT__;
  }
  
  // Clean up temporary directories
  const tempDirs = [
    '/tmp/liquid-snipe-test/keypairs',
    '/tmp/liquid-snipe-test/databases',
    '/tmp/liquid-snipe-test'
  ];
  
  for (const dir of tempDirs) {
    try {
      // Remove all files in directory first
      try {
        const files = await fs.readdir(dir);
        for (const file of files) {
          const filePath = path.join(dir, file);
          const stat = await fs.lstat(filePath);
          
          if (stat.isDirectory()) {
            await fs.rmdir(filePath, { recursive: true });
          } else {
            await fs.unlink(filePath);
          }
        }
      } catch (error) {
        // Directory might not exist or be empty
      }
      
      // Remove directory
      await fs.rmdir(dir);
      console.log(`✓ Cleaned up directory: ${dir}`);
    } catch (error) {
      // Directory might not exist
      if (error.code !== 'ENOENT') {
        console.warn(`⚠ Failed to clean up directory ${dir}:`, error.message);
      }
    }
  }
  
  // Clean up any remaining test files in other locations
  const possibleTestFiles = [
    '/tmp/test-e2e-keypair.json',
    '/tmp/perf-test-keypair.json',
    '/tmp/error-test-keypair.json',
    '/tmp/test-corruption-recovery.db'
  ];
  
  for (const filePath of possibleTestFiles) {
    try {
      await fs.unlink(filePath);
      console.log(`✓ Cleaned up test file: ${filePath}`);
    } catch (error) {
      // File might not exist
      if (error.code !== 'ENOENT') {
        console.warn(`⚠ Failed to clean up file ${filePath}:`, error.message);
      }
    }
  }
  
  // Clean up global test utilities
  delete global.testUtils;
  delete global.__ORIGINAL_TIMEOUT__;
  
  // Force garbage collection if available
  if (global.gc) {
    global.gc();
  }
  
  // Generate cleanup report
  const cleanupReport = {
    timestamp: new Date().toISOString(),
    cleaned: true,
    tempDirsRemoved: tempDirs.length,
    environment: 'integration-test'
  };
  
  console.log('✅ Integration test cleanup complete:', cleanupReport);
};
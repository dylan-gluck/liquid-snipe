/**
 * Custom test sequencer for integration tests
 * 
 * Controls the order of test execution to:
 * - Run dependent tests in correct order
 * - Minimize resource contention
 * - Optimize test performance
 * - Handle cleanup between test groups
 */

// Try to import DefaultSequencer, fallback to basic implementation if not available
let DefaultSequencer;
try {
  DefaultSequencer = require('@jest/test-sequencer').DefaultSequencer;
} catch (e) {
  // Fallback for older Jest versions
  class BasicSequencer {
    sort(tests) {
      return tests.sort((a, b) => a.path.localeCompare(b.path));
    }
    allFailedTests(tests) {
      return tests;
    }
  }
  DefaultSequencer = BasicSequencer;
}
const path = require('path');

class IntegrationTestSequencer extends DefaultSequencer {
  sort(tests) {
    // Define test execution order by priority
    const testPriorities = {
      // High priority - foundational tests that others depend on
      'wallet-operations': 1,
      'jupiter-integration': 2,
      'market-data-integration': 3,
      
      // Medium priority - core functionality tests
      'end-to-end-trading': 4,
      'performance-integration': 5,
      
      // Low priority - error and edge case tests
      'error-scenarios': 6
    };
    
    // Sort tests by priority, then by default criteria
    const sortedTests = tests.sort((testA, testB) => {
      const fileNameA = path.basename(testA.path, '.test.ts');
      const fileNameB = path.basename(testB.path, '.test.ts');
      
      const priorityA = testPriorities[fileNameA] || 999;
      const priorityB = testPriorities[fileNameB] || 999;
      
      // Sort by priority first
      if (priorityA !== priorityB) {
        return priorityA - priorityB;
      }
      
      // Then by file size (smaller files first for quick feedback)
      const sizeA = testA.context?.hasteFS?.getSize?.(testA.path) || 0;
      const sizeB = testB.context?.hasteFS?.getSize?.(testB.path) || 0;
      
      if (sizeA !== sizeB) {
        return sizeA - sizeB;
      }
      
      // Finally by filename alphabetically
      return fileNameA.localeCompare(fileNameB);
    });
    
    // Log test execution order for debugging
    console.log('🔍 Integration test execution order:');
    sortedTests.forEach((test, index) => {
      const fileName = path.basename(test.path, '.test.ts');
      const priority = testPriorities[fileName] || 999;
      console.log(`  ${index + 1}. ${fileName} (priority: ${priority})`);
    });
    
    return sortedTests;
  }
  
  allFailedTests(tests) {
    // Group failed tests by type for better reporting
    const failedByType = {};
    
    tests.forEach(test => {
      const fileName = path.basename(test.path, '.test.ts');
      const testType = this.getTestType(fileName);
      
      if (!failedByType[testType]) {
        failedByType[testType] = [];
      }
      failedByType[testType].push(fileName);
    });
    
    if (Object.keys(failedByType).length > 0) {
      console.log('❌ Failed integration tests by type:');
      Object.entries(failedByType).forEach(([type, files]) => {
        console.log(`  ${type}: ${files.join(', ')}`);
      });
    }
    
    return super.allFailedTests(tests);
  }
  
  getTestType(fileName) {
    if (fileName.includes('wallet')) return 'wallet';
    if (fileName.includes('jupiter')) return 'dex';
    if (fileName.includes('market-data')) return 'api';
    if (fileName.includes('end-to-end')) return 'e2e';
    if (fileName.includes('performance')) return 'performance';
    if (fileName.includes('error')) return 'error-handling';
    return 'other';
  }
}

module.exports = IntegrationTestSequencer;
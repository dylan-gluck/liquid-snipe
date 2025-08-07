/**
 * Atomic Position State Machine Usage Examples
 * 
 * This file demonstrates how to use the AtomicPositionStateMachine
 * and integration patterns for high-performance trading scenarios.
 */

import {
  AtomicPositionStateMachine,
  CompatibilityPositionStateMachine,
  createPositionStateMachine,
  PositionStateTransition,
  PositionState,
} from '../src/core/state-machines';

/**
 * Example 1: Basic Atomic Position State Machine Usage
 */
async function basicAtomicUsage() {
  console.log('=== Basic Atomic Usage ===');
  
  // Create atomic position state machine
  const stateMachine = new AtomicPositionStateMachine({
    positionId: 'pos_001',
    tokenAddress: '0x123...abc',
    entryPrice: 100.50,
    amount: 1000,
  });
  
  console.log('Initial state:', stateMachine.getCurrentState());
  
  // Start position monitoring
  const success = await stateMachine.transition(PositionStateTransition.POSITION_OPENED);
  console.log('Transition to monitoring:', success);
  console.log('Current state:', stateMachine.getCurrentState());
  
  // Update price atomically (fast path - lock-free)
  stateMachine.updatePrice(105.25);
  console.log('PnL after price update:', stateMachine.getPnL());
  
  // Get performance metrics
  const metrics = stateMachine.getPerformanceMetrics();
  console.log('Performance metrics:', metrics);
}

/**
 * Example 2: High-Frequency Price Updates
 */
async function highFrequencyUpdates() {
  console.log('\n=== High-Frequency Updates ===');
  
  const stateMachine = new AtomicPositionStateMachine({
    positionId: 'pos_002',
    tokenAddress: '0x456...def',
    entryPrice: 50.0,
    amount: 2000,
  });
  
  await stateMachine.transition(PositionStateTransition.POSITION_OPENED);
  
  // Simulate high-frequency price updates
  const startTime = process.hrtime.bigint();
  const iterations = 1000;
  
  for (let i = 0; i < iterations; i++) {
    // Random price movement ±5%
    const priceChange = (Math.random() - 0.5) * 0.1;
    const newPrice = 50.0 * (1 + priceChange);
    
    stateMachine.updatePrice(newPrice);
  }
  
  const endTime = process.hrtime.bigint();
  const totalTime = Number(endTime - startTime) / 1000000; // Convert to milliseconds
  
  console.log(`${iterations} price updates completed in ${totalTime.toFixed(2)}ms`);
  console.log(`Average latency: ${(totalTime / iterations).toFixed(4)}ms per update`);
  
  const finalMetrics = stateMachine.getPerformanceMetrics();
  console.log('Final performance metrics:', finalMetrics);
}

/**
 * Example 3: Concurrent State Transitions
 */
async function concurrentTransitions() {
  console.log('\n=== Concurrent Transitions ===');
  
  const stateMachine = new AtomicPositionStateMachine({
    positionId: 'pos_003',
    tokenAddress: '0x789...ghi',
    entryPrice: 75.0,
    amount: 500,
  });
  
  // Start position
  await stateMachine.transition(PositionStateTransition.POSITION_OPENED);
  
  // Simulate concurrent operations
  const operations = [
    // Price updates
    async () => {
      for (let i = 0; i < 100; i++) {
        stateMachine.updatePrice(75.0 + Math.random() * 10);
        await new Promise(resolve => setImmediate(resolve));
      }
    },
    
    // State transitions
    async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      await stateMachine.transition(PositionStateTransition.EXIT_CONDITION_MET);
      await new Promise(resolve => setTimeout(resolve, 10));
      await stateMachine.transition(PositionStateTransition.EXIT_APPROVED);
      await new Promise(resolve => setTimeout(resolve, 10));
      await stateMachine.transition(PositionStateTransition.EXIT_COMPLETED);
    },
    
    // Context reads
    async () => {
      for (let i = 0; i < 50; i++) {
        const context = stateMachine.getContext();
        const pnl = stateMachine.getPnL();
        await new Promise(resolve => setImmediate(resolve));
      }
    },
  ];
  
  const startTime = Date.now();
  await Promise.all(operations);
  const endTime = Date.now();
  
  console.log(`Concurrent operations completed in ${endTime - startTime}ms`);
  console.log('Final state:', stateMachine.getCurrentState());
  
  const metrics = stateMachine.getPerformanceMetrics();
  console.log('Concurrency performance metrics:', metrics);
}

/**
 * Example 4: Compatibility Wrapper Usage
 */
async function compatibilityWrapperUsage() {
  console.log('\n=== Compatibility Wrapper ===');
  
  const stateMachine = new CompatibilityPositionStateMachine({
    positionId: 'pos_004',
    tokenAddress: '0xabc...123',
    entryPrice: 200.0,
    amount: 100,
  });
  
  // Use synchronous interface (backward compatibility)
  console.log('Initial state:', stateMachine.getCurrentState());
  
  const success = stateMachine.transition(PositionStateTransition.POSITION_OPENED);
  console.log('Synchronous transition result:', success);
  
  // Use asynchronous interface (preferred for new code)
  const asyncSuccess = await stateMachine.transitionAsync(
    PositionStateTransition.EXIT_CONDITION_MET,
    { exitReason: 'Profit target reached' }
  );
  console.log('Asynchronous transition result:', asyncSuccess);
  
  // Both interfaces provide the same functionality
  console.log('Current state:', stateMachine.getCurrentState());
  console.log('Performance metrics:', stateMachine.getPerformanceMetrics());
}

/**
 * Example 5: State Machine Factory Usage
 */
async function factoryUsage() {
  console.log('\n=== Factory Usage ===');
  
  // Create atomic version
  const atomicStateMachine = createPositionStateMachine({
    positionId: 'pos_005_atomic',
    tokenAddress: '0xdef...456',
    entryPrice: 25.0,
    amount: 4000,
  }, true);
  
  // Create legacy version
  const legacyStateMachine = createPositionStateMachine({
    positionId: 'pos_005_legacy',
    tokenAddress: '0xdef...456',
    entryPrice: 25.0,
    amount: 4000,
  }, false);
  
  console.log('Atomic implementation:', atomicStateMachine.constructor.name);
  console.log('Legacy implementation:', legacyStateMachine.constructor.name);
  
  // Both provide the same interface
  atomicStateMachine.updatePrice(26.0);
  legacyStateMachine.updatePrice(26.0);
  
  console.log('Atomic PnL:', atomicStateMachine.getPnL());
  console.log('Legacy PnL:', legacyStateMachine.getPnL());
}

/**
 * Example 6: Performance Comparison
 */
async function performanceComparison() {
  console.log('\n=== Performance Comparison ===');
  
  const atomicStateMachine = new AtomicPositionStateMachine({
    positionId: 'perf_atomic',
    tokenAddress: '0xperf...test',
    entryPrice: 100.0,
    amount: 1000,
  });
  
  const { PositionStateMachine } = require('../src/core/state-machines/position-state-machine');
  const legacyStateMachine = new PositionStateMachine({
    positionId: 'perf_legacy',
    tokenAddress: '0xperf...test',
    entryPrice: 100.0,
    amount: 1000,
  });
  
  const iterations = 500;
  
  // Test atomic implementation
  await atomicStateMachine.transition(PositionStateTransition.POSITION_OPENED);
  const atomicStart = process.hrtime.bigint();
  
  for (let i = 0; i < iterations; i++) {
    atomicStateMachine.updatePrice(100 + Math.random() * 20);
  }
  
  const atomicEnd = process.hrtime.bigint();
  const atomicTime = Number(atomicEnd - atomicStart) / 1000000;
  
  // Test legacy implementation
  legacyStateMachine.transition(PositionStateTransition.POSITION_OPENED);
  const legacyStart = process.hrtime.bigint();
  
  for (let i = 0; i < iterations; i++) {
    legacyStateMachine.updatePrice(100 + Math.random() * 20);
  }
  
  const legacyEnd = process.hrtime.bigint();
  const legacyTime = Number(legacyEnd - legacyStart) / 1000000;
  
  console.log(`Atomic implementation: ${iterations} updates in ${atomicTime.toFixed(2)}ms`);
  console.log(`Legacy implementation: ${iterations} updates in ${legacyTime.toFixed(2)}ms`);
  console.log(`Performance improvement: ${(legacyTime / atomicTime).toFixed(2)}x faster`);
  
  const atomicMetrics = atomicStateMachine.getPerformanceMetrics();
  console.log('Atomic performance metrics:', atomicMetrics);
}

/**
 * Example 7: Error Handling and Recovery
 */
async function errorHandlingExample() {
  console.log('\n=== Error Handling ===');
  
  const stateMachine = new AtomicPositionStateMachine({
    positionId: 'error_test',
    tokenAddress: '0xerror...test',
    entryPrice: 50.0,
    amount: 1000,
  });
  
  await stateMachine.transition(PositionStateTransition.POSITION_OPENED);
  
  // Test invalid transition
  const invalidTransition = await stateMachine.transition(PositionStateTransition.EXIT_COMPLETED);
  console.log('Invalid transition result:', invalidTransition);
  
  // Test error state transition
  await stateMachine.transition(PositionStateTransition.ERROR_OCCURRED, {
    error: new Error('Simulated error'),
  });
  
  console.log('State after error:', stateMachine.getCurrentState());
  
  // Test recovery
  const recovery = await stateMachine.transition(PositionStateTransition.RECOVERY_COMPLETED);
  console.log('Recovery result:', recovery);
  console.log('State after recovery:', stateMachine.getCurrentState());
  
  const errorMetrics = stateMachine.getPerformanceMetrics();
  console.log('Error handling metrics:', errorMetrics);
}

/**
 * Run all examples
 */
async function runAllExamples() {
  try {
    await basicAtomicUsage();
    await highFrequencyUpdates();
    await concurrentTransitions();
    await compatibilityWrapperUsage();
    await factoryUsage();
    await performanceComparison();
    await errorHandlingExample();
    
    console.log('\n=== All Examples Completed Successfully ===');
  } catch (error) {
    console.error('Example execution failed:', error);
  }
}

// Run examples if this file is executed directly
if (require.main === module) {
  runAllExamples();
}

export {
  basicAtomicUsage,
  highFrequencyUpdates,
  concurrentTransitions,
  compatibilityWrapperUsage,
  factoryUsage,
  performanceComparison,
  errorHandlingExample,
  runAllExamples,
};
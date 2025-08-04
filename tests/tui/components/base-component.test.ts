import { BaseComponent } from '../../../src/tui/components/base-component';
import { TuiTheme } from '../../../src/tui';

// Mock blessed
jest.mock('blessed', () => ({
  box: jest.fn(() => ({
    on: jest.fn(),
    hide: jest.fn(),
    show: jest.fn(),
    focus: jest.fn(),
    blur: jest.fn(),
    setLabel: jest.fn(),
    setContent: jest.fn(),
    getContent: jest.fn(() => ''),
    destroy: jest.fn(),
    screen: {
      render: jest.fn(),
    },
  })),
}));

// Create a concrete implementation for testing
class TestComponent extends BaseComponent {
  private refreshCount = 0;

  constructor(theme: TuiTheme, title?: string) {
    super(theme, { title });
  }

  public refresh(): void {
    this.refreshCount++;
  }

  public getRefreshCount(): number {
    return this.refreshCount;
  }
}

describe('BaseComponent', () => {
  let mockTheme: TuiTheme;
  let testComponent: TestComponent;

  beforeEach(() => {
    mockTheme = {
      primary: 'blue',
      secondary: 'cyan',
      success: 'green',
      warning: 'yellow',
      error: 'red',
      info: 'white',
      border: 'white',
      background: 'black',
      text: 'white',
    };

    testComponent = new TestComponent(mockTheme, 'Test Component');
  });

  afterEach(() => {
    if (testComponent) {
      testComponent.destroy();
    }
  });

  describe('Initialization', () => {
    test('should create component with correct theme', () => {
      expect(testComponent).toBeDefined();
      expect(testComponent.getElement()).toBeDefined();
    });

    test('should be hidden initially', () => {
      expect(testComponent.isVisible()).toBe(false);
    });

    test('should not be active initially', () => {
      expect(testComponent.isActive()).toBe(false);
    });
  });

  describe('Visibility Management', () => {
    test('should show and hide correctly', () => {
      expect(testComponent.isVisible()).toBe(false);
      
      testComponent.show();
      expect(testComponent.isVisible()).toBe(true);
      
      testComponent.hide();
      expect(testComponent.isVisible()).toBe(false);
    });

    test('should handle multiple show/hide calls', () => {
      testComponent.show();
      testComponent.show();
      expect(testComponent.isVisible()).toBe(true);
      
      testComponent.hide();
      testComponent.hide();
      expect(testComponent.isVisible()).toBe(false);
    });
  });

  describe('Focus Management', () => {
    test('should handle focus and blur', () => {
      expect(() => {
        testComponent.focus();
        testComponent.blur();
      }).not.toThrow();
    });
  });

  describe('Content Management', () => {
    test('should set title correctly', () => {
      expect(() => {
        testComponent.setTitle('New Title');
      }).not.toThrow();
    });

    test('should set content correctly', () => {
      expect(() => {
        testComponent.setContent('Test content');
      }).not.toThrow();
    });

    test('should append content correctly', () => {
      expect(() => {
        testComponent.setContent('First line');
        testComponent.appendContent('\nSecond line');
      }).not.toThrow();
    });

    test('should clear content correctly', () => {
      expect(() => {
        testComponent.setContent('Some content');
        testComponent.clearContent();
      }).not.toThrow();
    });
  });

  describe('Refresh Management', () => {
    test('should call refresh when requested', () => {
      expect(testComponent.getRefreshCount()).toBe(0);
      
      testComponent.refresh();
      expect(testComponent.getRefreshCount()).toBe(1);
      
      testComponent.refresh();
      expect(testComponent.getRefreshCount()).toBe(2);
    });

    test('should throttle refresh calls', (done) => {
      expect(testComponent.getRefreshCount()).toBe(0);
      
      // Call throttled refresh multiple times quickly
      testComponent.throttledRefresh();
      testComponent.throttledRefresh();
      testComponent.throttledRefresh();
      
      // Only one should have executed
      expect(testComponent.getRefreshCount()).toBe(1);
      
      // Wait for throttle period to pass and try again
      setTimeout(() => {
        testComponent.throttledRefresh();
        expect(testComponent.getRefreshCount()).toBe(2);
        done();
      }, 1100); // Wait longer than the 1000ms throttle
    }, 2000);
  });

  describe('Formatting Utilities', () => {
    test('should format numbers correctly', () => {
      expect(testComponent['formatNumber'](1234.567, 2)).toBe('1,234.57');
      expect(testComponent['formatNumber'](1000, 0)).toBe('1,000');
    });

    test('should format currency correctly', () => {
      const formatted = testComponent['formatCurrency'](1234.56);
      expect(formatted).toMatch(/^\$1,234\.56$/);
    });

    test('should format percentages correctly', () => {
      expect(testComponent['formatPercent'](15.678, 2)).toBe('+15.68%');
      expect(testComponent['formatPercent'](-5.432, 1)).toBe('-5.4%');
      expect(testComponent['formatPercent'](0, 2)).toBe('+0.00%');
    });

    test('should format time correctly', () => {
      const timestamp = new Date('2023-01-01T12:30:45').getTime();
      const formatted = testComponent['formatTime'](timestamp);
      expect(formatted).toMatch(/12:30:45/);
    });

    test('should format duration correctly', () => {
      const now = Date.now();
      const oneHourAgo = now - (60 * 60 * 1000);
      const duration = testComponent['formatDuration'](oneHourAgo, now);
      expect(duration).toBe('1h 0m');
      
      const oneDayAgo = now - (24 * 60 * 60 * 1000);
      const dayDuration = testComponent['formatDuration'](oneDayAgo, now);
      expect(dayDuration).toBe('1d 0h');
    });
  });

  describe('Color Utilities', () => {
    test('should colorize text correctly', () => {
      const colorized = testComponent['colorizeText']('test', 'primary');
      expect(colorized).toBe('{blue-fg}test{/}');
    });

    test('should colorize positive/negative values correctly', () => {
      const positive = testComponent['colorizePositive'](10);
      expect(positive).toBe('{green-fg}10{/}');
      
      const negative = testComponent['colorizePositive'](-5);
      expect(negative).toBe('{red-fg}-5{/}');
      
      const zero = testComponent['colorizePositive'](0);
      expect(zero).toBe('{green-fg}0{/}');
    });

    test('should colorize status correctly', () => {
      expect(testComponent['colorizeStatus']('OPEN')).toBe('{green-fg}OPEN{/}');
      expect(testComponent['colorizeStatus']('ERROR')).toBe('{red-fg}ERROR{/}');
      expect(testComponent['colorizeStatus']('WARNING')).toBe('{yellow-fg}WARNING{/}');
      expect(testComponent['colorizeStatus']('UNKNOWN')).toBe('{white-fg}UNKNOWN{/}');
    });
  });

  describe('Table Utilities', () => {
    test('should format table rows correctly', () => {
      const columns = ['Column1', 'VeryLongColumn2', 'Col3'];
      const widths = [8, 10, 6];
      const formatted = testComponent['formatTableRow'](columns, widths);
      expect(formatted).toBe('Column1  VeryLon... Col3  ');
    });

    test('should create table headers correctly', () => {
      const headers = ['Name', 'Value', 'Status'];
      const widths = [10, 8, 6];
      const header = testComponent['createTableHeader'](headers, widths);
      expect(header).toContain('{bold}');
      expect(header).toContain('Name');
      expect(header).toContain('----------');
    });
  });

  describe('Error Handling', () => {
    test('should handle errors gracefully', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      
      const error = new Error('Test error');
      testComponent['handleError'](error, 'Test context');
      
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    test('should handle non-Error objects', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      
      testComponent['handleError']('String error', 'Test context');
      
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('Resource Management', () => {
    test('should clean up resources on destroy', () => {
      expect(() => {
        testComponent.destroy();
      }).not.toThrow();
    });
  });
});
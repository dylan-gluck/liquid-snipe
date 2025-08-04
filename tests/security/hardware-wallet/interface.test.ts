import { 
  HardwareWalletError, 
  HardwareWalletException,
  DEFAULT_HARDWARE_WALLET_CONFIG 
} from '../../../src/security/hardware-wallet/interface';

describe('HardwareWalletException', () => {
  it('should create exception with error type and message', () => {
    const exception = new HardwareWalletException(
      HardwareWalletError.NOT_CONNECTED,
      'Device not connected'
    );

    expect(exception.errorType).toBe(HardwareWalletError.NOT_CONNECTED);
    expect(exception.message).toBe('Device not connected');
    expect(exception.name).toBe('HardwareWalletException');
    expect(exception.originalError).toBeUndefined();
  });

  it('should create exception with original error', () => {
    const originalError = new Error('USB error');
    const exception = new HardwareWalletException(
      HardwareWalletError.COMMUNICATION_ERROR,
      'Communication failed',
      originalError
    );

    expect(exception.errorType).toBe(HardwareWalletError.COMMUNICATION_ERROR);
    expect(exception.message).toBe('Communication failed');
    expect(exception.originalError).toBe(originalError);
  });

  it('should be instanceof Error', () => {
    const exception = new HardwareWalletException(
      HardwareWalletError.USER_REJECTED,
      'User rejected'
    );

    expect(exception).toBeInstanceOf(Error);
    expect(exception).toBeInstanceOf(HardwareWalletException);
  });
});

describe('DEFAULT_HARDWARE_WALLET_CONFIG', () => {
  it('should have correct default values', () => {
    expect(DEFAULT_HARDWARE_WALLET_CONFIG).toEqual({
      enabled: false,
      defaultDerivationPath: "m/44'/501'/0'/0'",
      timeout: 30000,
      requireConfirmation: true,
      blindSigning: false,
      autoConnect: true,
      reconnectAttempts: 3,
      reconnectDelay: 2000,
    });
  });

  it('should be immutable by reference but values can be overridden', () => {
    const config = { ...DEFAULT_HARDWARE_WALLET_CONFIG };
    config.enabled = true;
    config.timeout = 60000;

    expect(DEFAULT_HARDWARE_WALLET_CONFIG.enabled).toBe(false);
    expect(DEFAULT_HARDWARE_WALLET_CONFIG.timeout).toBe(30000);
    expect(config.enabled).toBe(true);
    expect(config.timeout).toBe(60000);
  });
});

describe('HardwareWalletError enum', () => {
  it('should contain all expected error types', () => {
    const expectedErrors = [
      'NOT_CONNECTED',
      'DEVICE_LOCKED',
      'APP_NOT_OPEN',
      'USER_REJECTED',
      'TIMEOUT',
      'FIRMWARE_OUTDATED',
      'DEVICE_NOT_GENUINE',
      'TRANSACTION_TOO_LARGE',
      'UNSUPPORTED_OPERATION',
      'COMMUNICATION_ERROR',
    ];

    expectedErrors.forEach(error => {
      expect(Object.values(HardwareWalletError)).toContain(error);
    });
  });

  it('should have unique values', () => {
    const values = Object.values(HardwareWalletError);
    const uniqueValues = [...new Set(values)];
    
    expect(values.length).toBe(uniqueValues.length);
  });
});
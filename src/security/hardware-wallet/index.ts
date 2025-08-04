// Core interfaces and types
export {
  HardwareWalletInterface,
  HardwareWalletFactory,
  HardwareWalletInfo,
  ConnectionStatus,
  HardwareCapabilities,
  HardwareAccount,
  HardwareSigningOptions,
  HardwareSigningResult,
  HardwareWalletConfig,
  HardwareWalletError,
  HardwareWalletException,
  DEFAULT_HARDWARE_WALLET_CONFIG,
} from './interface';

// Hardware wallet adapters
export { LedgerAdapter, type LedgerConfig } from './ledger-adapter';
export { TrezorAdapter, type TrezorConfig } from './trezor-adapter';
export { MockAdapter, type MockAdapterConfig } from './mock-adapter';

// Factory and utilities
export {
  HardwareWalletFactoryImpl,
  HardwareWalletType,
  DetectionResult,
  createHardwareWalletFactory,
  getAvailableWalletTypes,
  isWalletTypeSupported,
} from './factory';
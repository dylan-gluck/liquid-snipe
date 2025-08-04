import dotenv from 'dotenv';
import { ConfigManager, ConfigValidationError } from './config-manager';
import defaultConfig from './default';

// Load environment variables from .env file
dotenv.config();

// Export the ConfigManager and default config
export { ConfigManager, ConfigValidationError, defaultConfig };

// Export a singleton instance for common use
export const configManager = new ConfigManager();
export default configManager;

// Jest setup for database mocking
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';

// Mock sqlite3 to prevent native binding issues
jest.mock('sqlite3', () => ({
  Database: jest.fn().mockImplementation(() => ({
    run: jest.fn((sql, params, callback) => callback && callback(null)),
    get: jest.fn((sql, params, callback) => callback && callback(null, null)),
    all: jest.fn((sql, params, callback) => callback && callback(null, [])),
    close: jest.fn((callback) => callback && callback(null)),
    serialize: jest.fn((callback) => callback && callback()),
  })),
  OPEN_READWRITE: 1,
  OPEN_CREATE: 4,
}));

// Mock blessed for TUI testing
jest.mock('blessed', () => ({
  screen: jest.fn(() => ({
    render: jest.fn(),
    destroy: jest.fn(),
    key: jest.fn(),
    append: jest.fn(),
  })),
  box: jest.fn(() => ({
    setContent: jest.fn(),
    render: jest.fn(),
  })),
  list: jest.fn(() => ({
    setItems: jest.fn(),
    render: jest.fn(),
  })),
  table: jest.fn(() => ({
    setData: jest.fn(),
    render: jest.fn(),
  })),
  textbox: jest.fn(() => ({
    setValue: jest.fn(),
    render: jest.fn(),
  })),
}));
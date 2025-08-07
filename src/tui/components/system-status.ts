import blessed from 'blessed';
import { BaseComponent, ComponentConfig } from './base-component';
import { TuiTheme } from '../index';
import { EventProcessor, SystemStatusEvent, ConnectionStatusEvent } from '../../events/types';

interface ConnectionInfo {
  type: 'RPC' | 'WEBSOCKET' | 'DATABASE';
  status: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING' | 'ERROR';
  endpoint?: string;
  latency?: number;
  lastUpdate: number;
  error?: string;
}

interface SystemInfo {
  status: 'STARTING' | 'READY' | 'PAUSED' | 'ERROR' | 'SHUTDOWN' | 'CRITICAL_ERROR';
  uptime: number;
  memoryUsage: number;
  cpuUsage: number;
  connections: ConnectionInfo[];
  lastUpdate: number;
}

export class SystemStatus extends BaseComponent {
  private systemInfo: SystemInfo = {
    status: 'STARTING',
    uptime: Date.now(),
    memoryUsage: 0,
    cpuUsage: 0,
    connections: [],
    lastUpdate: Date.now(),
  };

  constructor(
    private eventProcessor: EventProcessor,
    theme: TuiTheme,
    config: ComponentConfig = {},
  ) {
    super(
      theme,
      {
        title: 'System Status',
        top: '50%',
        left: 0,
        width: '100%',
        height: '50%',
        border: true,
        scrollable: true,
        ...config,
      },
      'SystemStatus',
    );

    this.setupEventListeners();
  }

  protected createElement(): void {
    super.createElement();
    this.updateDisplay();
  }

  private setupEventListeners(): void {
    // Listen for system status events
    this.eventProcessor.on('systemStatus', (event: SystemStatusEvent) => {
      this.updateSystemStatus(event);
    });

    // Listen for connection status events
    this.eventProcessor.on('connectionStatus', (event: ConnectionStatusEvent) => {
      this.updateConnectionStatus(event);
    });
  }

  private updateSystemStatus(event: SystemStatusEvent): void {
    this.systemInfo.status = event.status;
    this.systemInfo.lastUpdate = event.timestamp;

    // Update memory and CPU if available in details
    if (event.details) {
      if (event.details.memoryUsage) {
        this.systemInfo.memoryUsage = event.details.memoryUsage;
      }
      if (event.details.cpuUsage) {
        this.systemInfo.cpuUsage = event.details.cpuUsage;
      }
    }

    this.updateDisplay();
  }

  private updateConnectionStatus(event: ConnectionStatusEvent): void {
    const existingIndex = this.systemInfo.connections.findIndex(
      conn => conn.type === event.type && conn.endpoint === event.endpoint,
    );

    const connectionInfo: ConnectionInfo = {
      type: event.type,
      status: event.status,
      endpoint: event.endpoint,
      latency: event.latency,
      lastUpdate: event.timestamp,
      error: event.error,
    };

    if (existingIndex >= 0) {
      this.systemInfo.connections[existingIndex] = connectionInfo;
    } else {
      this.systemInfo.connections.push(connectionInfo);
    }

    this.updateDisplay();
  }

  private updateDisplay(): void {
    const content = this.formatSystemDisplay();
    this.setContent(content);
  }

  private formatSystemDisplay(): string {
    // Safety check to ensure systemInfo is defined
    if (!this.systemInfo) {
      return '{red-fg}System status not loaded{/red-fg}';
    }

    const { status, uptime, memoryUsage, cpuUsage, connections, lastUpdate } = this.systemInfo;

    let content = `{bold}System Status{/bold}\n`;
    content += `${'-'.repeat(20)}\n`;

    // System status
    content += `Status:         ${this.colorizeStatus(status)}\n`;
    content += `Uptime:         ${this.formatDuration(uptime)}\n`;

    // Performance metrics
    if (memoryUsage > 0) {
      content += `Memory:         ${this.formatMemoryUsage(memoryUsage)}\n`;
    }
    if (cpuUsage > 0) {
      content += `CPU:            ${this.formatCpuUsage(cpuUsage)}\n`;
    }

    content += `Last Update:    ${this.formatTime(lastUpdate)}\n\n`;

    // Connection status
    content += `{bold}Connections{/bold}\n`;
    content += `${'-'.repeat(20)}\n`;

    if (connections.length === 0) {
      content += `{${this.theme.secondary}-fg}No connections{/}\n`;
    } else {
      for (const conn of connections) {
        content += this.formatConnectionLine(conn);
      }
    }

    return content;
  }

  private formatConnectionLine(conn: ConnectionInfo): string {
    let line = `${conn.type.padEnd(10)} `;

    // Status with color
    line += `${this.colorizeStatus(conn.status).padEnd(15)} `;

    // Latency if available
    if (conn.latency !== undefined) {
      const latencyColor =
        conn.latency > 1000
          ? this.theme.error
          : conn.latency > 500
            ? this.theme.warning
            : this.theme.success;
      line += `{${latencyColor}-fg}${conn.latency}ms{/}`;
    }

    line += '\n';

    // Error information if present
    if (conn.error && conn.status === 'ERROR') {
      line += `${' '.repeat(11)}{${this.theme.error}-fg}${conn.error}{/}\n`;
    }

    // Endpoint information if available
    if (conn.endpoint && conn.type !== 'DATABASE') {
      const shortEndpoint = this.shortenEndpoint(conn.endpoint);
      line += `${' '.repeat(11)}{${this.theme.secondary}-fg}${shortEndpoint}{/}\n`;
    }

    return line;
  }

  private shortenEndpoint(endpoint: string): string {
    if (endpoint.length <= 30) {
      return endpoint;
    }

    // Try to extract meaningful parts
    if (endpoint.startsWith('https://')) {
      const parts = endpoint.replace('https://', '').split('/');
      return `https://${parts[0]}/...`;
    } else if (endpoint.startsWith('wss://')) {
      const parts = endpoint.replace('wss://', '').split('/');
      return `wss://${parts[0]}/...`;
    }

    return `${endpoint.substring(0, 27)}...`;
  }

  private formatMemoryUsage(bytes: number): string {
    const mb = bytes / (1024 * 1024);
    const color = mb > 500 ? this.theme.error : mb > 200 ? this.theme.warning : this.theme.success;

    return `{${color}-fg}${mb.toFixed(1)} MB{/}`;
  }

  private formatCpuUsage(percent: number): string {
    const color =
      percent > 80 ? this.theme.error : percent > 50 ? this.theme.warning : this.theme.success;

    return `{${color}-fg}${percent.toFixed(1)}%{/}`;
  }

  public async refresh(): Promise<void> {
    // Update system performance metrics
    this.updatePerformanceMetrics();
    this.updateDisplay();
  }

  private updatePerformanceMetrics(): void {
    // Get Node.js process memory usage
    const memUsage = process.memoryUsage();
    this.systemInfo.memoryUsage = memUsage.heapUsed;

    // CPU usage would require more complex calculation
    // For now, we'll use a mock value or skip it
    // this.systemInfo.cpuUsage = getCpuUsage(); // Not implemented

    this.systemInfo.lastUpdate = Date.now();
  }

  public getStatusSummary(): { status: string; connections: number; uptime: string } {
    const connectedCount = this.systemInfo.connections.filter(
      conn => conn.status === 'CONNECTED',
    ).length;

    return {
      status: this.systemInfo.status,
      connections: connectedCount,
      uptime: this.formatDuration(this.systemInfo.uptime),
    };
  }

  public getConnectionStatus(type: 'RPC' | 'WEBSOCKET' | 'DATABASE'): ConnectionInfo | undefined {
    return this.systemInfo.connections.find(conn => conn.type === type);
  }

  public isSystemHealthy(): boolean {
    const systemOk = ['READY', 'PAUSED'].includes(this.systemInfo.status);
    const connectionsOk = this.systemInfo.connections.every(conn =>
      ['CONNECTED', 'RECONNECTING'].includes(conn.status),
    );

    return systemOk && connectionsOk;
  }

  public getSystemMetrics(): {
    uptime: number;
    memoryUsage: number;
    cpuUsage: number;
    activeConnections: number;
    status: string;
  } {
    const activeConnections = this.systemInfo.connections.filter(
      conn => conn.status === 'CONNECTED',
    ).length;

    return {
      uptime: Date.now() - this.systemInfo.uptime,
      memoryUsage: this.systemInfo.memoryUsage,
      cpuUsage: this.systemInfo.cpuUsage,
      activeConnections,
      status: this.systemInfo.status,
    };
  }

  // Method to simulate connection events for testing
  public simulateConnectionEvent(
    type: 'RPC' | 'WEBSOCKET' | 'DATABASE',
    status: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING' | 'ERROR',
    endpoint?: string,
    latency?: number,
    error?: string,
  ): void {
    const event: ConnectionStatusEvent = {
      type,
      status,
      endpoint,
      latency,
      timestamp: Date.now(),
      error,
    };

    this.updateConnectionStatus(event);
  }

  // Method to simulate system status events for testing
  public simulateSystemEvent(
    status: 'STARTING' | 'READY' | 'PAUSED' | 'ERROR' | 'SHUTDOWN',
    details?: Record<string, any>,
  ): void {
    const event: SystemStatusEvent = {
      status,
      timestamp: Date.now(),
      details,
    };

    this.updateSystemStatus(event);
  }

  protected onResize(): void {
    this.updateDisplay();
  }
}

export default SystemStatus;

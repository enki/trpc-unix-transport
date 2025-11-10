import type { Socket } from 'net';
import { EventEmitter } from 'events';

/**
 * Generic length-prefixed message transport for Unix sockets
 *
 * Wire format: "00000042\n{...payload...}\n"
 * - 8-digit zero-padded length prefix
 * - Newline delimiter after length
 * - Payload (any string, not necessarily JSON)
 * - Trailing newline after payload
 *
 * This is extracted from JsonRpcTransport to be protocol-agnostic
 */
export class LengthPrefixedTransport extends EventEmitter {
  private buffer = '';
  private readonly maxMessageSize = 1024 * 1024; // 1MB max message size

  constructor(private socket: Socket) {
    super();
    this.socket.on('data', this.handleData.bind(this));
    this.socket.on('error', (err) => this.emit('error', err));
    this.socket.on('close', () => this.emit('close'));
  }

  /**
   * Send a message with length prefix
   */
  async send(message: string): Promise<void> {
    if (message.length > this.maxMessageSize) {
      throw new Error(
        `Message too large: ${message.length} bytes (max ${this.maxMessageSize})`
      );
    }

    // Use 8-digit length prefix to support up to 99,999,999 bytes
    const length = message.length.toString().padStart(8, '0');
    const frame = `${length}\n${message}\n`;

    return new Promise((resolve, reject) => {
      this.socket.write(frame, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Handle incoming data, extract messages
   */
  private handleData(data: Buffer): void {
    this.buffer += data.toString();

    // Process all complete messages in buffer
    let message = this.extractMessage();
    while (message) {
      this.emit('message', message);
      message = this.extractMessage();
    }

    // Prevent buffer overflow
    if (this.buffer.length > this.maxMessageSize) {
      this.emit('error', new Error('Buffer overflow - message too large'));
      this.buffer = '';
    }
  }

  /**
   * Extract one complete message from buffer
   */
  private extractMessage(): string | null {
    // Look for length prefix
    const lengthEnd = this.buffer.indexOf('\n');
    if (lengthEnd === -1 || lengthEnd !== 8) {
      return null; // Incomplete or invalid length prefix
    }

    const lengthStr = this.buffer.substring(0, 8);
    const length = parseInt(lengthStr, 10);

    if (isNaN(length)) {
      // Invalid length, skip this line
      this.buffer = this.buffer.substring(lengthEnd + 1);
      this.emit('error', new Error(`Invalid length prefix: ${lengthStr}`));
      return null;
    }

    // Check if we have the complete message
    const messageStart = lengthEnd + 1;
    const messageEnd = messageStart + length;

    if (this.buffer.length < messageEnd + 1) {
      return null; // Incomplete message
    }

    // Extract message
    const message = this.buffer.substring(messageStart, messageEnd);

    // Verify trailing newline
    if (this.buffer[messageEnd] !== '\n') {
      this.emit('error', new Error('Missing trailing newline'));
      // Skip the malformed message
      this.buffer = this.buffer.substring(messageEnd);
      return null;
    }

    // Remove processed message from buffer
    this.buffer = this.buffer.substring(messageEnd + 1);

    return message;
  }

  /**
   * Close the transport
   */
  close(): void {
    this.socket.end();
  }
}

/**
 * Create a transport from an existing socket
 */
export function createTransport(socket: Socket): LengthPrefixedTransport {
  return new LengthPrefixedTransport(socket);
}

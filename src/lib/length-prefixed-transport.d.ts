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
export declare class LengthPrefixedTransport extends EventEmitter {
    private socket;
    private buffer;
    private readonly maxMessageSize;
    constructor(socket: Socket);
    /**
     * Send a message with length prefix
     */
    send(message: string): Promise<void>;
    /**
     * Handle incoming data, extract messages
     */
    private handleData;
    /**
     * Extract one complete message from buffer
     */
    private extractMessage;
    /**
     * Close the transport
     */
    close(): void;
}
/**
 * Create a transport from an existing socket
 */
export declare function createTransport(socket: Socket): LengthPrefixedTransport;
//# sourceMappingURL=length-prefixed-transport.d.ts.map
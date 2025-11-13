import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { Socket } from 'net';
import { LengthPrefixedTransport } from './length-prefixed-transport.js';
/**
 * Stateless Unix socket link - creates a new connection per request
 * like HTTP, avoiding connection management complexity
 */
export function unixSocketLink(opts) {
    return () => {
        return ({ op }) => {
            return observable((observer) => {
                let socket = null;
                let transport = null;
                const requestId = Date.now() + Math.random();
                // Helper to cleanup
                const cleanup = () => {
                    if (transport) {
                        transport.removeAllListeners();
                        transport = null;
                    }
                    if (socket && !socket.destroyed) {
                        socket.end();
                        socket = null;
                    }
                };
                // Create new connection for this request
                socket = new Socket();
                transport = new LengthPrefixedTransport(socket);
                // Set up error handler before connecting
                socket.on('error', (err) => {
                    observer.error(new TRPCClientError(err.message));
                    cleanup();
                });
                // Also handle transport errors to prevent unhandled error events
                transport.on('error', (_err) => {
                    // Socket error handler will handle this, just prevent unhandled error
                });
                // Handle response
                transport.on('message', (message) => {
                    try {
                        const response = JSON.parse(message);
                        if (response.id !== requestId)
                            return;
                        if (response.error) {
                            observer.error(new TRPCClientError(response.error.message || 'Unknown error'));
                        }
                        else if (response.result) {
                            // Extract the actual data from tRPC response structure
                            const trpcResult = response.result;
                            let finalResult;
                            if (trpcResult.type === 'data' && 'data' in trpcResult) {
                                // The data is already deserialized by the server, just extract it
                                finalResult = trpcResult.data;
                            }
                            else {
                                finalResult = trpcResult;
                            }
                            // For subscriptions, don't close connection
                            if (op.type === 'subscription') {
                                observer.next({ result: { data: finalResult } });
                                if (response.result.type === 'stopped') {
                                    observer.complete();
                                    cleanup();
                                }
                            }
                            else {
                                // For queries/mutations, complete and close
                                observer.next({ result: { data: finalResult } });
                                observer.complete();
                                cleanup();
                            }
                        }
                    }
                    catch (err) {
                        observer.error(new TRPCClientError(err instanceof Error ? err.message : 'Parse error'));
                        cleanup();
                    }
                });
                // Connect and send request
                socket.connect(opts.socketPath, async () => {
                    try {
                        const serializedInput = opts.transformer?.serialize
                            ? opts.transformer.serialize(op.input)
                            : op.input;
                        const request = {
                            id: requestId,
                            jsonrpc: '2.0',
                            method: 'trpc',
                            params: {
                                path: op.path,
                                input: serializedInput,
                                type: op.type,
                                context: op.context,
                            },
                        };
                        if (transport) {
                            await transport.send(JSON.stringify(request));
                        }
                    }
                    catch (err) {
                        observer.error(new TRPCClientError(err instanceof Error ? err.message : 'Send error'));
                        cleanup();
                    }
                });
                // Return cleanup function for unsubscribe
                return () => {
                    if (op.type === 'subscription' && transport) {
                        // Send unsubscribe
                        transport
                            .send(JSON.stringify({
                            id: requestId,
                            jsonrpc: '2.0',
                            method: 'trpc.subscription.stop',
                            params: { id: requestId },
                        }))
                            .catch(() => {
                            /* ignore */
                        });
                    }
                    cleanup();
                };
            });
        };
    };
}

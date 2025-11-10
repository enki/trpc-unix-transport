import { createServer, Socket, type Server as NetServer } from 'net';
import { dirname } from 'path';
import { promises as fs } from 'fs';
import { LengthPrefixedTransport } from './length-prefixed-transport.js';
import {
  TRPCError,
  callTRPCProcedure,
  type AnyRouter,
  type inferRouterContext,
} from '@trpc/server';
import { isObservable, type Unsubscribable } from '@trpc/server/observable';
import type { Logger } from '@vibe/logger';

export interface TRPCUnixServerOptions<TRouter extends AnyRouter = AnyRouter> {
  router: TRouter;
  createContext: () =>
    | Promise<inferRouterContext<TRouter>>
    | inferRouterContext<TRouter>;
  socketPath: string;
}

// Simple error conversion utility
function getTRPCErrorFromUnknown(cause: unknown): TRPCError {
  if (cause instanceof TRPCError) {
    return cause;
  }

  const error = cause instanceof Error ? cause : new Error(String(cause));
  const trpcError = new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    cause: error,
    message: error.message,
  });

  // Inherit stack from error
  if (error.stack) {
    trpcError.stack = error.stack;
  }

  return trpcError;
}

export interface TRPCResponse {
  id: string | number;
  result?: {
    type: 'data' | 'stopped';
    data?: unknown;
  };
  error?: {
    message: string;
    code: string;
    data?: unknown;
  };
}

/**
 * Serves tRPC over Unix domain socket
 * Uses length-prefixed protocol for message framing
 */
export class TRPCUnixServer<TRouter extends AnyRouter = AnyRouter> {
  private server?: NetServer;
  private socketPath: string;
  private subscriptions = new Map<string, Unsubscribable>();
  private logger: Logger;
  private connectionCount = 0;
  private isHealthy = false;

  constructor(
    private options: TRPCUnixServerOptions<TRouter>,
    logger: Logger
  ) {
    // Logger MUST be provided via DI from UnixTransportStrategy
    this.logger = logger;

    // Socket path provided by caller
    this.socketPath = this.options.socketPath;

    this.logger.info({
      socketPath: this.socketPath
    }, 'TRPCUnixServer initialized');
  }

  /**
   * Start the Unix socket server with comprehensive error handling and verification
   */
  async start(): Promise<void> {
    const startTime = Date.now();
    this.logger.info('🚀 Starting Unix socket server');

    try {
      // Phase 1: Pre-flight checks
      await this.preflightChecks();

      // Phase 2: Socket creation (with timeout)
      await this.createSocket();

      // Phase 3: Post-creation verification
      await this.verifySocket();

      // Phase 4: Install health monitoring
      this.installHealthMonitoring();

      const elapsed = Date.now() - startTime;
      this.isHealthy = true;
      this.logger.info({
        socketPath: this.socketPath,
        elapsedMs: elapsed
      }, '✅ Unix socket server started successfully');

    } catch (error) {
      this.isHealthy = false;
      this.logger.fatal({
        err: error,
        socketPath: this.socketPath,
        elapsedMs: Date.now() - startTime
      }, '❌ Failed to start Unix socket server');

      // Cleanup on failure
      await this.cleanup();

      throw new Error(
        `Unix socket server failed to start: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async stop(): Promise<void> {
    this.logger.info('Stopping Unix socket server');
    this.isHealthy = false;
    await this.cleanup();
    this.logger.info('Unix socket server stopped');
  }

  /**
   * Helper: Execute async operation with timeout
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    operation: string
  ): Promise<T> {
    let timeoutId: NodeJS.Timeout | undefined;

    const timeoutPromise = new Promise<T>((_, reject) => {
      timeoutId = setTimeout(() => {
        this.logger.error({ operation, timeoutMs }, 'Operation timeout');
        reject(new Error(`${operation} timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([promise, timeoutPromise]);
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId); // Clear timeout when promise wins
      }
      return result;
    } catch (error) {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId); // Clear timeout on error too
      }
      throw error;
    }
  }

  /**
   * Test if socket is connectable (without sending data)
   */
  private async testSocketConnection(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const testSocket = new Socket();

      const timeout = setTimeout(() => {
        testSocket.destroy();
        resolve(false);
      }, timeoutMs);

      testSocket.once('connect', () => {
        clearTimeout(timeout);
        testSocket.end();
        resolve(true);
      });

      testSocket.once('error', () => {
        clearTimeout(timeout);
        resolve(false);
      });

      testSocket.connect(this.socketPath);
    });
  }

  /**
   * Phase 1: Pre-flight checks before attempting socket creation
   */
  private async preflightChecks(): Promise<void> {
    this.logger.debug('Phase 1: Pre-flight checks');

    const socketDir = dirname(this.socketPath);

    // Check if directory exists and is writable
    try {
      const stats = await this.withTimeout(
        fs.stat(socketDir),
        5000,
        'stat socket directory'
      );

      this.logger.debug({
        socketDir,
        mode: stats.mode.toString(8),
        uid: stats.uid,
        gid: stats.gid,
        isDirectory: stats.isDirectory()
      }, 'Socket directory exists');

      if (!stats.isDirectory()) {
        throw new Error(`Socket directory path exists but is not a directory: ${socketDir}`);
      }

    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.logger.info({ socketDir }, 'Socket directory does not exist, will create');
      } else {
        this.logger.error({ err, socketDir }, 'Cannot access socket directory');
        throw new Error(`Socket directory not accessible: ${socketDir}`);
      }
    }

    // Check if socket file already exists and test if it's stale
    try {
      const stats = await fs.stat(this.socketPath);
      this.logger.warn({
        socketPath: this.socketPath,
        mode: stats.mode.toString(8),
        isSocket: stats.isSocket()
      }, 'Socket file already exists, will attempt cleanup');

      // Try to connect to see if it's a live socket
      const isLive = await this.testSocketConnection(500); // Quick 500ms test
      if (isLive) {
        throw new Error(
          `Socket file exists and appears to be in use: ${this.socketPath}. ` +
          `Another instance may be running.`
        );
      }
      this.logger.info('Existing socket appears stale, will remove');

    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.logger.debug('Socket file does not exist (good)');
      } else if (err instanceof Error && err.message.includes('Another instance')) {
        throw err; // Re-throw if it's a live socket
      }
    }
  }

  /**
   * Phase 2: Create the Unix socket with comprehensive monitoring
   */
  private async createSocket(): Promise<void> {
    this.logger.debug('Phase 2: Socket creation');

    const socketDir = dirname(this.socketPath);

    // Step 1: Ensure directory exists (with timeout)
    this.logger.debug({ socketDir }, 'Creating socket directory');
    await this.withTimeout(
      fs.mkdir(socketDir, { recursive: true }),
      5000,
      'mkdir socket directory'
    );
    this.logger.debug('Socket directory created/verified');

    // Step 2: Clean up existing socket (with timeout)
    try {
      await this.withTimeout(
        fs.unlink(this.socketPath),
        5000,
        'unlink existing socket'
      );
      this.logger.info({ socketPath: this.socketPath }, 'Removed existing socket file');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn({ err, socketPath: this.socketPath }, 'Error unlinking socket (continuing)');
      }
    }

    // Step 3: Create server instance
    this.logger.debug('Creating net.Server instance');
    this.server = createServer();

    // Step 4: Set up connection handler with logging
    this.server.on('connection', (socket) => {
      this.connectionCount++;
      const connId = this.connectionCount;

      const transport = new LengthPrefixedTransport(socket);

      transport.on('message', async (message: string) => {
        let requestId: string | number | undefined;
        try {
          const request = JSON.parse(message);
          requestId = request.id;

          // Handle tRPC request
          if (request.method === 'trpc') {
            await this.handleTRPCRequest(transport, request, socket);
          } else if (request.method === 'trpc.subscription.stop') {
            const subscriptionId = request.params?.id;
            if (subscriptionId && this.subscriptions.has(subscriptionId)) {
              this.subscriptions.get(subscriptionId)?.unsubscribe();
              this.subscriptions.delete(subscriptionId);
            }
            await transport.send(
              JSON.stringify({
                id: request.id,
                jsonrpc: '2.0',
                result: { success: true },
              })
            );
          } else if (request.method === 'ping') {
            // Health check endpoint
            await transport.send(
              JSON.stringify({
                id: request.id,
                jsonrpc: '2.0',
                result: { pong: true, healthy: this.isHealthy },
              })
            );
          }
        } catch (error) {
          this.logger.error({ err: error, connId, requestId }, 'Error handling request');
          if (requestId !== undefined) {
            await transport.send(
              JSON.stringify({
                id: requestId,
                jsonrpc: '2.0',
                error: {
                  code: -32603,
                  message: error instanceof Error ? error.message : 'Internal error',
                },
              })
            );
          }
        }
      });

      socket.on('error', (err) => {
        this.logger.error({ err, connId }, 'Socket connection error');
      });

      socket.on('close', () => {
        // Connection closed - no logging needed for normal operation
      });
    });

    // Step 5: Bind to socket path (with timeout)
    this.logger.info({ socketPath: this.socketPath }, 'Binding to socket path');

    await new Promise<void>((resolve, reject) => {
      if (!this.server) {
        reject(new Error('Server not initialized'));
        return;
      }

      const timeoutMs = 30000; // 30 seconds for bind
      const timeout = setTimeout(() => {
        this.logger.error({
          socketPath: this.socketPath,
          timeoutMs
        }, 'server.listen() callback timeout - kernel may be unresponsive');

        reject(new Error(
          `server.listen() callback did not fire after ${timeoutMs}ms. ` +
          `This suggests kernel/filesystem issue. Socket: ${this.socketPath}`
        ));
      }, timeoutMs);

      this.server.listen(this.socketPath, () => {
        clearTimeout(timeout);
        this.logger.info({ socketPath: this.socketPath }, 'server.listen() callback fired');
        resolve();
      });

      this.server.on('error', (err) => {
        clearTimeout(timeout);
        this.logger.error({ err, socketPath: this.socketPath }, 'Server error during bind');
        reject(err);
      });
    });

    // Step 6: Set permissions (with timeout)
    this.logger.debug('Setting socket permissions to 0o600');
    await this.withTimeout(
      fs.chmod(this.socketPath, 0o600),
      2000,
      'chmod socket file'
    );
    this.logger.debug('Socket permissions set');
  }

  /**
   * Phase 3: Verify socket is actually functional
   */
  private async verifySocket(): Promise<void> {
    this.logger.debug('Phase 3: Post-creation verification');

    // Step 1: Verify file exists with retry (for filesystem sync delays)
    this.logger.debug('Waiting for socket file to become visible on filesystem');

    let retries = 0;
    const maxRetries = 50; // 5 seconds total (50 * 100ms)
    let fileFound = false;

    while (retries < maxRetries) {
      try {
        const stats = await fs.stat(this.socketPath);

        if (!stats.isSocket()) {
          throw new Error(`Path exists but is not a socket: ${this.socketPath}`);
        }

        this.logger.info({
          socketPath: this.socketPath,
          mode: stats.mode.toString(8),
          retriesNeeded: retries,
          delayMs: retries * 100
        }, 'Socket file verified on filesystem');

        fileFound = true;
        break;

      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          this.logger.debug({
            retries,
            maxRetries,
            socketPath: this.socketPath
          }, 'Socket file not yet visible, retrying');

          await new Promise(resolve => setTimeout(resolve, 100));
          retries++;
        } else {
          this.logger.error({ err }, 'Error during file verification');
          throw err;
        }
      }
    }

    if (!fileFound) {
      throw new Error(
        `Socket file never became visible after ${maxRetries * 100}ms. ` +
        `This suggests severe filesystem delay or failure. Socket: ${this.socketPath}`
      );
    }

    // Step 2: Verify socket is connectable
    this.logger.debug('Testing socket connectivity');
    const isConnectable = await this.testSocketConnection(2000);

    if (!isConnectable) {
      throw new Error(`Socket file exists but is not connectable: ${this.socketPath}`);
    }

    this.logger.info('Socket connectivity verified - test connection succeeded');

    // Step 3: Verify socket can echo (full round-trip test)
    this.logger.debug('Testing socket round-trip communication');
    await this.testSocketEcho();
    this.logger.info('Socket echo test passed - full communication verified');
  }

  /**
   * Test full round-trip communication (connect + send + receive)
   */
  private async testSocketEcho(): Promise<void> {
    return new Promise((resolve, reject) => {
      const testSocket = new Socket();
      const transport = new LengthPrefixedTransport(testSocket);

      const timeout = setTimeout(() => {
        testSocket.destroy();
        reject(new Error('Echo test timeout after 2s'));
      }, 2000);

      transport.once('message', (response: string) => {
        clearTimeout(timeout);

        try {
          const parsed = JSON.parse(response);
          if (parsed.result?.pong === true) {
            testSocket.end();
            resolve();
          } else {
            reject(new Error(`Unexpected echo response: ${response}`));
          }
        } catch (err) {
          reject(new Error(`Invalid echo response: ${err}`));
        }
      });

      testSocket.once('connect', async () => {
        try {
          await transport.send(JSON.stringify({
            id: 'health-check',
            jsonrpc: '2.0',
            method: 'ping',
          }));
        } catch (err) {
          clearTimeout(timeout);
          reject(err);
        }
      });

      testSocket.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      testSocket.connect(this.socketPath);
    });
  }

  /**
   * Phase 4: Install runtime health monitoring
   */
  private installHealthMonitoring(): void {
    this.logger.debug('Phase 4: Installing health monitoring');

    if (!this.server) return;

    // Persistent error handler for runtime issues
    this.server.on('error', (err) => {
      this.isHealthy = false;
      this.logger.error({ err }, '🔴 Socket server error (runtime)');
    });

    this.logger.debug('Health monitoring installed');
  }

  /**
   * Cleanup resources
   */
  private async cleanup(): Promise<void> {
    this.logger.debug('Cleaning up resources');

    if (this.server) {
      try {
        const server = this.server;
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      } catch (err) {
        this.logger.error({ err }, 'Error closing server during cleanup');
      }
      this.server = undefined;
    }

    try {
      await fs.unlink(this.socketPath);
      this.logger.debug('Socket file removed during cleanup');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn({ err }, 'Error removing socket during cleanup');
      }
    }
  }

  /**
   * Handle a tRPC request using the proper tRPC server API
   */
  private async handleTRPCRequest(
    transport: LengthPrefixedTransport,
    request: {
      id: string | number;
      params: {
        path: string;
        input: unknown;
        type: 'query' | 'mutation' | 'subscription';
        context?: unknown;
      };
    },
    socket: Socket
  ): Promise<void> {
    const { id } = request;
    const { path, input: serializedInput, type } = request.params;

    // Avoid console.log in production to prevent EPIPE errors

    // Create context for this request
    const ctx = await this.options.createContext();

    // Deserialize input if the router has a transformer
    const routerWithConfig = this.options.router as AnyRouter & {
      _def: {
        _config: {
          transformer?: { input: { deserialize: (data: unknown) => unknown } };
        };
      };
    };
    const transformer = routerWithConfig._def._config.transformer;
    const input =
      transformer?.input && serializedInput !== undefined
        ? transformer.input.deserialize(serializedInput)
        : serializedInput;

    // Helper to send responses
    const respond = async (response: TRPCResponse) => {
      await transport.send(
        JSON.stringify({
          ...response,
          jsonrpc: '2.0',
        })
      );
    };

    try {
      // Use tRPC's callTRPCProcedure with router
      const result = await callTRPCProcedure({
        ctx,
        path,
        router: this.options.router,
        input,
        type,
        getRawInput: async () => input,
        signal: new AbortController().signal,
      });

      if (type !== 'subscription') {
        await respond({
          id,
          result: {
            type: 'data',
            data: result,
          },
        });
      } else {
        if (!isObservable(result)) {
          throw new TRPCError({
            message: `Subscription ${path} did not return an observable`,
            code: 'INTERNAL_SERVER_ERROR',
          });
        }

        const subscriptionId = `${socket.remoteAddress}:${id}`;
        const subscription = result.subscribe({
          next: async (data) => {
            await respond({
              id,
              result: {
                type: 'data',
                data,
              },
            });
          },
          error: async (err) => {
            const error = getTRPCErrorFromUnknown(err);
            await respond({
              id,
              error: {
                message: error.message,
                code: error.code || 'INTERNAL_SERVER_ERROR',
                data: error.cause,
              },
            });
          },
          complete: async () => {
            await respond({
              id,
              result: {
                type: 'stopped',
              },
            });
            this.subscriptions.delete(subscriptionId);
          },
        });

        this.subscriptions.set(subscriptionId, subscription);
      }
    } catch (cause) {
      const error = getTRPCErrorFromUnknown(cause);
      const errorData = (error as TRPCError & { data?: unknown }).data;
      const errorDataRecord =
        errorData && typeof errorData === 'object' && !Array.isArray(errorData)
          ? (errorData as Record<string, unknown>)
          : undefined;
      const errorDataObject: Record<string, unknown> = errorDataRecord ?? {};
      await respond({
        id,
        error: {
          message: error.message,
          code: error.code || 'INTERNAL_SERVER_ERROR',
          data: {
            cause: error.cause,
            ...errorDataObject,
          },
        },
      });
    }
  }
}

export function createTRPCUnixServer<TRouter extends AnyRouter = AnyRouter>(
  options: TRPCUnixServerOptions<TRouter>,
  logger: Logger
): TRPCUnixServer<TRouter> {
  return new TRPCUnixServer(options, logger);
}

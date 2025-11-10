import { type AnyRouter, type inferRouterContext } from '@trpc/server';
import type { Logger } from '@vibe/logger';
export interface TRPCUnixServerOptions<TRouter extends AnyRouter = AnyRouter> {
    router: TRouter;
    createContext: () => Promise<inferRouterContext<TRouter>> | inferRouterContext<TRouter>;
    environment: string;
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
export declare class TRPCUnixServer<TRouter extends AnyRouter = AnyRouter> {
    private options;
    private server?;
    private socketPath;
    private subscriptions;
    private logger;
    private connectionCount;
    private isHealthy;
    constructor(options: TRPCUnixServerOptions<TRouter>, logger: Logger);
    /**
     * Start the Unix socket server with comprehensive error handling and verification
     */
    start(): Promise<void>;
    stop(): Promise<void>;
    /**
     * Helper: Execute async operation with timeout
     */
    private withTimeout;
    /**
     * Test if socket is connectable (without sending data)
     */
    private testSocketConnection;
    /**
     * Phase 1: Pre-flight checks before attempting socket creation
     */
    private preflightChecks;
    /**
     * Phase 2: Create the Unix socket with comprehensive monitoring
     */
    private createSocket;
    /**
     * Phase 3: Verify socket is actually functional
     */
    private verifySocket;
    /**
     * Test full round-trip communication (connect + send + receive)
     */
    private testSocketEcho;
    /**
     * Phase 4: Install runtime health monitoring
     */
    private installHealthMonitoring;
    /**
     * Cleanup resources
     */
    private cleanup;
    /**
     * Handle a tRPC request using the proper tRPC server API
     */
    private handleTRPCRequest;
}
export declare function createTRPCUnixServer<TRouter extends AnyRouter = AnyRouter>(options: TRPCUnixServerOptions<TRouter>, logger: Logger): TRPCUnixServer<TRouter>;

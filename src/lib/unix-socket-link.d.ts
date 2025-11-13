import type { TRPCLink } from '@trpc/client';
import type { AnyRouter } from '@trpc/server';
export interface UnixSocketLinkOptions {
    socketPath: string;
    transformer?: {
        serialize: (object: unknown) => unknown;
        deserialize: (object: unknown) => unknown;
    };
}
/**
 * Stateless Unix socket link - creates a new connection per request
 * like HTTP, avoiding connection management complexity
 */
export declare function unixSocketLink<TRouter extends AnyRouter>(opts: UnixSocketLinkOptions): TRPCLink<TRouter>;
//# sourceMappingURL=unix-socket-link.d.ts.map
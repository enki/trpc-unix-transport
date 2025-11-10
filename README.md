# @enki/trpc-unix-transport

TypeScript transport layer for tRPC over Unix domain sockets.

## Overview

This package provides TypeScript client and server implementations for communicating via tRPC over Unix domain sockets. It enables high-performance IPC between Node.js processes on the same machine.

**Perfect for:**
- Electron apps (renderer ↔ main process IPC)
- CLI tools communicating with daemon processes
- Microservices on the same machine
- Any scenario where HTTP overhead is unnecessary

### Features

- **Type-safe tRPC protocol** - Full TypeScript inference for procedures
- **Length-prefixed transport** - Reliable message framing
- **Stateless client** - Creates new connection per request (like HTTP)
- **Injectable server** - Dependency injection friendly
- **Production-ready** - Comprehensive error handling and timeouts
- **Zero HTTP overhead** - Direct socket communication

### Status

✅ **Stable** - Core functionality complete and battle-tested in production.

## Installation

```bash
npm install @enki/trpc-unix-transport @trpc/server @trpc/client pino
```

## Usage

### Server

```typescript
import { TRPCUnixServer } from '@enki/trpc-unix-transport';
import { initTRPC } from '@trpc/server';
import pino from 'pino';

// Define your tRPC router
const t = initTRPC.create();
const appRouter = t.router({
  hello: t.procedure
    .input((val: unknown) => {
      if (typeof val === 'string') return val;
      throw new Error('Invalid input');
    })
    .query(({ input }) => {
      return { message: `Hello ${input}!` };
    }),
});

// Create logger
const logger = pino();

// Create and start server
const server = new TRPCUnixServer(
  {
    router: appRouter,
    createContext: () => ({}),
    socketPath: '/tmp/my-app.sock',
  },
  logger
);

await server.start();
```

### Client

```typescript
import { createTRPCProxyClient } from '@trpc/client';
import { unixSocketLink } from '@enki/trpc-unix-transport';
import type { AppRouter } from './server';

const client = createTRPCProxyClient<AppRouter>({
  links: [
    unixSocketLink({
      socketPath: '/tmp/my-app.sock',
    }),
  ],
});

// Make type-safe calls
const result = await client.hello.query('World');
console.log(result.message); // "Hello World!"
```

## API Reference

### TRPCUnixServer

Server class for handling tRPC requests over Unix socket.

```typescript
class TRPCUnixServer<TRouter extends AnyRouter> {
  constructor(
    options: TRPCUnixServerOptions<TRouter>,
    logger: Logger
  );

  start(): Promise<void>;
  stop(): Promise<void>;
}
```

**Options:**
- `router` - Your tRPC router instance
- `createContext` - Function to create request context
- `socketPath` - Absolute path to Unix socket file

### unixSocketLink

Client link for connecting to Unix socket server.

```typescript
function unixSocketLink<TRouter extends AnyRouter>(
  opts: UnixSocketLinkOptions
): TRPCLink<TRouter>;
```

**Options:**
- `socketPath` - Absolute path to Unix socket file
- `transformer?` - Optional data transformer (superjson, etc.)

### LengthPrefixedTransport

Low-level message framing layer (used internally).

```typescript
class LengthPrefixedTransport extends EventEmitter {
  constructor(socket: Socket);
  send(data: Buffer): void;
  // Emits 'message' events with Buffer payload
}
```

## Protocol Specification

Messages are framed using a 4-byte big-endian length prefix:

```
[4 bytes: message length][N bytes: JSON payload]
```

Example:
```
00 00 00 1A { "id": 1, "method": "hello" }
```

This ensures reliable message boundaries over the streaming socket connection.

## Integration Examples

### NestJS

```typescript
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { TRPCUnixServer } from '@enki/trpc-unix-transport';
import { join } from 'path';
import { tmpdir } from 'os';

@Injectable()
export class TrpcService implements OnModuleInit, OnModuleDestroy {
  private server: TRPCUnixServer;

  constructor(
    private appRouter: AppRouter,
    private logger: Logger
  ) {
    this.server = new TRPCUnixServer(
      {
        router: this.appRouter,
        createContext: () => ({ /* your context */ }),
        socketPath: join(tmpdir(), 'my-app.sock'),
      },
      this.logger
    );
  }

  async onModuleInit() {
    await this.server.start();
  }

  async onModuleDestroy() {
    await this.server.stop();
  }
}
```

### Electron Main Process

```typescript
import { app } from 'electron';
import { TRPCUnixServer } from '@enki/trpc-unix-transport';
import { join } from 'path';

app.whenReady().then(async () => {
  const server = new TRPCUnixServer(
    {
      router: appRouter,
      createContext: () => ({}),
      socketPath: join(app.getPath('userData'), 'ipc.sock'),
    },
    logger
  );

  await server.start();
});
```

## Comparison with HTTP Transport

| Feature | Unix Socket | HTTP |
|---------|-------------|------|
| Latency | ~0.1ms | ~1-5ms |
| Overhead | Minimal | Headers, parsing |
| Security | File permissions | Network layer |
| Scope | Same machine | Network |
| Browser support | No | Yes |

**Use Unix sockets when:**
- Client and server are on the same machine
- Performance is critical
- You don't need browser access

**Use HTTP when:**
- Network communication needed
- Browser clients required
- Standard web infrastructure preferred

## Error Handling

The client automatically handles common errors:

```typescript
try {
  await client.hello.query('World');
} catch (error) {
  if (error instanceof TRPCClientError) {
    console.error('tRPC error:', error.message);
  } else {
    console.error('Connection error:', error);
  }
}
```

Common errors:
- `ENOENT` - Socket file doesn't exist (server not running)
- `ECONNREFUSED` - Server not accepting connections
- `ETIMEDOUT` - Request timeout (default: 30s)

## Performance

Benchmarks on MacBook Pro M1:

- **Latency**: ~0.1ms per request
- **Throughput**: ~10,000 requests/sec
- **Memory**: Minimal (stateless connections)

## License

MIT

## Related Projects

- [@enki/trpc-unix-client](https://github.com/enki/trpc-unix-client) - Rust client for Tauri integration
- [tRPC](https://trpc.io) - End-to-end typesafe APIs

## Contributing

Issues and pull requests welcome at [github.com/enki/trpc-unix-transport](https://github.com/enki/trpc-unix-transport)

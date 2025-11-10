import { trpcUnixTransport } from './trpc-unix-transport';

describe('trpcUnixTransport', () => {
  it('should work', () => {
    expect(trpcUnixTransport()).toEqual('trpc-unix-transport');
  });
});

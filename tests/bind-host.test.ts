import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { BIND_HOST } from '../src/server/bind';

describe('server bind host', () => {
  it('is a loopback address', () => {
    // 127.0.0.0/8 is the IPv4 loopback range; ::1 is the IPv6 loopback.
    const host: string = BIND_HOST;
    const isLoopback = host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
    expect(isLoopback).toBe(true);
  });

  it('actually binds to loopback when passed to serve()', async () => {
    const app = new Hono();
    const info = await new Promise<AddressInfo>((resolve) => {
      const server = serve(
        { fetch: app.fetch, port: 0, hostname: BIND_HOST },
        (addr) => {
          server.close();
          resolve(addr);
        },
      );
    });
    // Node reports the bound address; for 127.0.0.1 this should round-trip.
    expect(info.address).toBe(BIND_HOST);
  });
});

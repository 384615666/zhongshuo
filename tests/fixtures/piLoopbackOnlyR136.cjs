'use strict';
/* global require */
// Applied only to the isolated official CLI, never to the host application.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Node --require preload must be CommonJS.
const net = require('node:net');
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const first = normalized[0];
  const host = typeof first === 'object' ? first.host : normalized[1];
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error('R136 fixture denied non-loopback socket');
  }
  return connect.apply(this, args);
};

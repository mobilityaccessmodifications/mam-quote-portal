import net from 'node:net';
// Real Redis protocol adapter for integration tests; no external test dependency.
export class TestRedis {
  async command(args) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port: Number(process.env.REDIS_TEST_PORT || 16379) });
      let buffer = Buffer.alloc(0);
      socket.setTimeout(5000, () => socket.destroy(new Error('Redis test timeout')));
      socket.on('error', reject);
      socket.on('connect', () => {
        const parts = [`*${args.length}\r\n`];
        for (const arg of args) { const value = String(arg); parts.push(`$${Buffer.byteLength(value)}\r\n${value}\r\n`); }
        socket.write(parts.join(''));
      });
      socket.on('data', (data) => {
        buffer = Buffer.concat([buffer, data]);
        function parse(offset = 0) {
          const end = buffer.indexOf('\r\n', offset);
          if (end < 0) return null;
          const kind = String.fromCharCode(buffer[offset]), value = buffer.toString('utf8', offset+1, end);
          let next = end+2;
          if (kind === '+') return [value, next];
          if (kind === '-') throw new Error(value);
          if (kind === ':') return [Number(value), next];
          if (kind === '$') {
            const size = Number(value);
            if (size === -1) return [null, next];
            if (buffer.length < next+size+2) return null;
            return [buffer.toString('utf8', next, next+size), next+size+2];
          }
          if (kind === '*') {
            const rows = [];
            for (let i=0; i<Number(value); i++) { const result = parse(next); if (!result) return null; rows.push(result[0]); next=result[1]; }
            return [rows,next];
          }
          throw new Error('Unexpected RESP value');
        }
        try { const result = parse(); if (result) { socket.end(); resolve(result[0]); } }
        catch (error) { socket.destroy(); reject(error); }
      });
    });
  }
  eval(script, keys, args = []) { return this.command(['EVAL', script, keys.length, ...keys, ...args]); }
}

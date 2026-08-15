import { Readable, Writable } from 'stream';

// Satır ayraçlı JSON. stdout yalnızca bu protokole ait; her türlü log stderr'e gider.

export interface Request {
  id?: number;
  method: string;
  params?: any;
}

type Handler = (params: any) => Promise<any> | any;

export class RpcPeer {
  private handlers = new Map<string, Handler>();
  private buffer = '';

  constructor(private readonly input: Readable, private readonly output: Writable) {
    input.setEncoding('utf8');
    input.on('data', chunk => this.onData(chunk as string));
  }

  on(method: string, handler: Handler) {
    this.handlers.set(method, handler);
  }

  notify(method: string, params: any) {
    this.write({ method, params });
  }

  private write(payload: any) {
    this.output.write(JSON.stringify(payload) + '\n');
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) {
        this.dispatch(line);
      }
      index = this.buffer.indexOf('\n');
    }
  }

  private async dispatch(line: string) {
    let request: Request;
    try {
      request = JSON.parse(line);
    } catch (error) {
      this.write({ error: { message: `Geçersiz JSON: ${(error as Error).message}` } });
      return;
    }

    const handler = this.handlers.get(request.method);
    if (!handler) {
      if (request.id !== undefined) {
        this.write({ id: request.id, error: { message: `Bilinmeyen metot: ${request.method}` } });
      }
      return;
    }

    try {
      const result = await handler(request.params ?? {});
      if (request.id !== undefined) {
        this.write({ id: request.id, result: result ?? null });
      }
    } catch (error) {
      if (request.id !== undefined) {
        this.write({
          id: request.id,
          error: { message: (error as Error).message ?? String(error) },
        });
      }
    }
  }
}

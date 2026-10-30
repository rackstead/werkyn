// A scriptable stand-in for the browser WebSocket used by realtime tests. The
// test plays the server: it opens the socket, authenticates it and delivers
// frames, and reads back every frame the client sent.
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;

  readonly url: string;
  readonly sent: Record<string, unknown>[] = [];
  readyState = 0;
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  static latest(): FakeWebSocket {
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) throw new Error("No WebSocket was opened");
    return socket;
  }

  static reset() {
    FakeWebSocket.instances = [];
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.closed = true;
    this.readyState = 3;
  }

  /** Server accepts the connection and the client's token. */
  accept() {
    this.readyState = 1;
    this.onopen?.({});
    this.deliver({ event: "authenticated" });
  }

  /** Server drops the connection. */
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }

  /** Server closes the connection with a status code. */
  closeWith(code: number, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  /** Server sends one frame: objects are serialized, strings sent verbatim. */
  deliver(frame: unknown) {
    this.onmessage?.({
      data: typeof frame === "string" ? frame : JSON.stringify(frame),
    });
  }

  framesOfType(...types: string[]) {
    return this.sent.filter((frame) => types.includes(frame.type as string));
  }
}

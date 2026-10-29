// A small in-process SMTP server for tests. It speaks just enough ESMTP for
// Nodemailer (EHLO, optional STARTTLS, AUTH PLAIN/LOGIN, MAIL, RCPT, DATA,
// RSET, QUIT) and records every session, so a test can check what a real
// SMTP client put on the wire.
import net from "node:net";
import tls from "node:tls";

/**
 * @param {object} [options]
 * @param {{ user: string, pass: string }} [options.auth] advertise AUTH and accept these credentials
 * @param {boolean} [options.rejectAuth] answer every AUTH attempt with 535
 * @param {boolean} [options.requireTls] answer MAIL FROM with 530 until STARTTLS
 * @param {{ key: string, cert: string }} [options.tls] advertise STARTTLS with this key pair
 * @param {boolean} [options.implicitTls] wrap the socket in TLS before the greeting (needs options.tls)
 */
export async function startSmtpCapture(options = {}) {
  const sessions = [];
  const sockets = new Set();

  const server = net.createServer((raw) => {
    sockets.add(raw);
    raw.on("close", () => sockets.delete(raw));
    raw.on("error", () => {});
    const session = { commands: [], auth: null, tls: false, messages: [], closed: false };
    sessions.push(session);
    if (options.implicitTls) {
      const secure = new tls.TLSSocket(raw, { isServer: true, ...options.tls });
      secure.on("error", () => {});
      session.tls = true;
      serve(secure, session, options);
    } else {
      serve(raw, session, options);
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    sessions,
    /** Every accepted message across sessions. */
    get messages() {
      return sessions.flatMap((session) => session.messages);
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function serve(initialSocket, session, options) {
  let socket = initialSocket;
  let buffer = "";
  let mode = "command";
  let pending = null;
  let envelope = { from: null, to: [] };
  let data = [];

  const reply = (line) => {
    if (!socket.destroyed) socket.write(`${line}\r\n`);
  };

  const ehlo = () => {
    const lines = ["250-capture.test", "250-8BITMIME", "250-SMTPUTF8"];
    if (options.tls && !session.tls) lines.push("250-STARTTLS");
    if ((options.auth || options.rejectAuth) && (session.tls || !options.tls)) {
      lines.push("250-AUTH PLAIN LOGIN");
    }
    lines.push("250 SIZE 10485760");
    return lines.join("\r\n");
  };

  const finishAuth = (user, pass) => {
    session.auth = { user, pass };
    const ok =
      !options.rejectAuth && options.auth && options.auth.user === user && options.auth.pass === pass;
    reply(ok ? "235 2.7.0 Authentication successful" : "535 5.7.8 Authentication credentials invalid");
  };

  const onLine = (line) => {
    if (mode === "data") {
      if (line === ".") {
        session.messages.push({ envelope, data: data.join("\r\n") + "\r\n" });
        envelope = { from: null, to: [] };
        data = [];
        mode = "command";
        reply("250 2.0.0 Ok: queued as CAPTURE1");
      } else {
        data.push(line.startsWith(".") ? line.slice(1) : line);
      }
      return;
    }
    if (mode === "auth-plain") {
      mode = "command";
      const [, user, pass] = Buffer.from(line, "base64").toString("utf8").split("\0");
      finishAuth(user, pass);
      return;
    }
    if (mode === "auth-login-user") {
      pending = Buffer.from(line, "base64").toString("utf8");
      mode = "auth-login-pass";
      reply("334 UGFzc3dvcmQ6");
      return;
    }
    if (mode === "auth-login-pass") {
      mode = "command";
      finishAuth(pending, Buffer.from(line, "base64").toString("utf8"));
      return;
    }

    session.commands.push(line);
    const verb = line.split(" ")[0].toUpperCase();
    if (verb === "EHLO") reply(ehlo());
    else if (verb === "HELO") reply("250 capture.test");
    else if (verb === "STARTTLS" && options.tls && !session.tls) {
      reply("220 2.0.0 Ready to start TLS");
      socket.removeAllListeners("data");
      const secure = new tls.TLSSocket(socket, { isServer: true, ...options.tls });
      secure.on("error", () => {});
      session.tls = true;
      socket = secure;
      buffer = "";
      socket.on("data", onData);
      socket.on("close", () => (session.closed = true));
    } else if (verb === "AUTH") {
      const [, method, initial] = line.split(" ");
      if (method?.toUpperCase() === "PLAIN" && initial) {
        const [, user, pass] = Buffer.from(initial, "base64").toString("utf8").split("\0");
        finishAuth(user, pass);
      } else if (method?.toUpperCase() === "PLAIN") {
        mode = "auth-plain";
        reply("334 ");
      } else if (method?.toUpperCase() === "LOGIN") {
        mode = "auth-login-user";
        reply("334 VXNlcm5hbWU6");
      } else {
        reply("504 5.5.4 Unrecognized authentication type");
      }
    } else if (verb === "MAIL") {
      if (options.requireTls && !session.tls) {
        reply("530 5.7.0 Must issue a STARTTLS command first");
      } else {
        envelope.from = line.slice(line.indexOf(":") + 1).trim();
        reply("250 2.1.0 Ok");
      }
    } else if (verb === "RCPT") {
      envelope.to.push(line.slice(line.indexOf(":") + 1).trim());
      reply("250 2.1.5 Ok");
    } else if (verb === "DATA") {
      mode = "data";
      reply("354 End data with <CR><LF>.<CR><LF>");
    } else if (verb === "RSET") {
      envelope = { from: null, to: [] };
      reply("250 2.0.0 Ok");
    } else if (verb === "NOOP") reply("250 2.0.0 Ok");
    else if (verb === "QUIT") {
      reply("221 2.0.0 Bye");
      socket.end();
    } else reply("502 5.5.2 Command not recognized");
  };

  const onData = (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\r\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      onLine(line);
    }
  };

  socket.on("data", onData);
  socket.on("close", () => (session.closed = true));
  reply("220 capture.test ESMTP");
}

/** Splits a captured RFC 5322 message into unfolded headers and a decoded MIME tree. */
export function parseMessage(raw) {
  const split = raw.indexOf("\r\n\r\n");
  const headerBlock = raw.slice(0, split);
  const body = raw.slice(split + 4);
  const headerLines = headerBlock.split("\r\n");
  const headers = [];
  for (const line of headerLines) {
    if (/^[ \t]/.test(line) && headers.length) headers[headers.length - 1].value += line;
    else {
      const colon = line.indexOf(":");
      headers.push({ name: line.slice(0, colon), value: line.slice(colon + 1).trim() });
    }
  }
  const get = (name) => headers.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value;
  const contentType = get("Content-Type") ?? "text/plain";
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
  let parts = [];
  if (boundary) {
    const sections = body.split(`--${boundary}`);
    parts = sections
      .slice(1, -1)
      .map((section) => parseMessage(section.replace(/^\r\n/, "").replace(/\r\n$/, "")));
  }
  return {
    headerLines,
    headers,
    get,
    contentType,
    parts,
    text: boundary ? null : decodeBody(body, get("Content-Transfer-Encoding")),
  };
}

function decodeBody(body, encoding = "7bit") {
  const kind = encoding.toLowerCase();
  if (kind === "base64") return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  if (kind === "quoted-printable") {
    const bytes = body
      .replace(/=\r\n/g, "")
      .replace(/=([0-9A-F]{2})/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
    return Buffer.from(bytes, "latin1").toString("utf8");
  }
  return body;
}

/** Decodes RFC 2047 encoded words in a header value. */
export function decodeWords(value) {
  return value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_match, _charset, kind, text) =>
      kind.toUpperCase() === "B"
        ? Buffer.from(text, "base64").toString("utf8")
        : Buffer.from(
            text
              .replace(/_/g, " ")
              .replace(/=([0-9A-F]{2})/gi, (_m, hex) => String.fromCharCode(parseInt(hex, 16))),
            "latin1",
          ).toString("utf8"),
    );
}

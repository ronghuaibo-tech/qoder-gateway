import fs from "node:fs";
import crypto from "node:crypto";
import net from "node:net";
import process from "node:process";
import { inspectJsonLine } from "./protocol.mjs";
import { probeUnixSocket } from "./transport.mjs";

export async function probeTcp(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ host, port, tcp_open: false });
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve({ host, port, tcp_open: true });
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve({ host, port, tcp_open: false });
    });
  });
}

export async function probeWebSocket(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const key = crypto.randomBytes(16).toString("base64");
    let data = "";
    const finish = (result) => {
      socket.destroy();
      resolve({ host, port, ...result });
    };
    const timer = setTimeout(() => finish({ websocket: false, timeout: true }), timeoutMs);
    socket.once("connect", () => {
      socket.write([
        "GET / HTTP/1.1",
        `Host: ${host}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Key: ${key}`,
        "",
        ""
      ].join("\r\n"));
    });
    socket.on("data", (chunk) => {
      data += chunk.toString("latin1");
      if (!data.includes("\r\n\r\n")) return;
      clearTimeout(timer);
      const header = data.split("\r\n\r\n", 1)[0].split("\r\n");
      const status = Number(header[0]?.split(" ")[1]);
      const upgrade = header.find((line) => /^upgrade:/i.test(line))?.split(":")[1]?.trim();
      finish({ websocket: status === 101 && upgrade?.toLowerCase() === "websocket", status, upgrade });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      finish({ websocket: false, error: error.code ?? error.message });
    });
  });
}

async function main() {
  const fixtureIndex = process.argv.indexOf("--fixture");
  if (fixtureIndex >= 0) {
    const fixturePath = process.argv[fixtureIndex + 1];
    for (const line of fs.readFileSync(fixturePath, "utf8").split(/\r?\n/).filter(Boolean)) {
      console.log(JSON.stringify(inspectJsonLine(line, { direction: "fixture", source: fixturePath })));
    }
    return;
  }
  const portIndex = process.argv.indexOf("--port");
  if (portIndex >= 0) {
    const host = process.argv[portIndex + 1] ?? "127.0.0.1";
    const port = Number(process.argv[portIndex + 2]);
    const websocket = process.argv.includes("--websocket");
    console.log(JSON.stringify(await (websocket ? probeWebSocket(host, port) : probeTcp(host, port))));
    return;
  }
  const socketIndex = process.argv.indexOf("--socket");
  if (socketIndex >= 0) {
    const socketPath = process.argv[socketIndex + 1];
    console.log(JSON.stringify(await probeUnixSocket(socketPath)));
    return;
  }
  console.error("usage: node qoder-bridge/probe.mjs --fixture path.jsonl | --port 127.0.0.1 37510 [--websocket] | --socket /path/to/qodercn.sock");
  process.exitCode = 2;
}

if (process.argv[1] && process.argv[1].endsWith("/qoder-bridge/probe.mjs")) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

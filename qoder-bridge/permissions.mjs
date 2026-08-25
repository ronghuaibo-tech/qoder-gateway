export function validateBridgePermissions(options = {}) {
  const listenHost = options.listenHost ?? "127.0.0.1";
  if (!["127.0.0.1", "::1", "localhost"].includes(listenHost)) {
    throw new Error("qoder-bridge must listen on localhost");
  }
  if (options.allowCommands === true) {
    throw new Error("qoder-bridge does not allow terminal commands");
  }
  return {
    localOnly: true,
    allowCommands: false,
    toolMode: options.toolMode ?? "dry-run"
  };
}

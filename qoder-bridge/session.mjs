export function createSessionStore() {
  const sessions = new Map();

  return {
    create(requestId) {
      const controller = new AbortController();
      const session = { requestId, controller, createdAt: Date.now() };
      sessions.set(requestId, session);
      return session;
    },
    get(requestId) {
      return sessions.get(requestId);
    },
    cancel(requestId) {
      const session = sessions.get(requestId);
      if (!session) return false;
      session.controller.abort();
      return true;
    },
    delete(requestId) {
      sessions.delete(requestId);
    },
    size() {
      return sessions.size;
    }
  };
}

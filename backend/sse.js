const clients = new Map(); // userId -> Set of res

function addClient(userId, res) {
  if (!userId || !res) return;
  let set = clients.get(userId);
  if (!set) {
    set = new Set();
    clients.set(userId, set);
  }
  set.add(res);

  // Cleanup when the connection is closed by the client
  const cleanup = () => {
    try {
      removeClient(userId, res);
    } catch (e) {
      /* ignore */
    }
  };

  // Attach close/finish listeners if available (Express/Node streams)
  if (typeof res.on === 'function') {
    res.on('close', cleanup);
    res.on('finish', cleanup);
  }
}

function removeClient(userId, res) {
  if (!userId || !res) return;
  const set = clients.get(userId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) clients.delete(userId);
}

function sendToUser(userId, payload) {
  try {
    const set = clients.get(userId);
    if (!set) return false;
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    for (const res of Array.from(set)) {
      try {
        // If response is already closed, remove it from the set
        if (res.destroyed || res.writableEnded || res.writableFinished) {
          removeClient(userId, res);
          continue;
        }

        // Write SSE event (notification)
        res.write('event: notification\n');
        // Send data as a single JSON string; ensure newline separation per SSE spec
        res.write(`data: ${data.replace(/\n/g, '\\n')}\n\n`);
      } catch (e) {
        // On any write error, remove this client and continue
        try {
          removeClient(userId, res);
        } catch (err) {
          /* ignore cleanup error */
        }
      }
    }
    return true;
  } catch (e) {
    console.error('sse sendToUser error', e);
    return false;
  }
}

function sendPing() {
  for (const [userId, set] of clients.entries()) {
    for (const res of Array.from(set)) {
      try {
        if (res.destroyed || res.writableEnded || res.writableFinished) {
          removeClient(userId, res);
          continue;
        }
        // comment ping so it's ignored by EventSource
        res.write(': ping\n\n');
      } catch (e) {
        try {
          removeClient(userId, res);
        } catch (err) {
          /* ignore cleanup error */
        }
      }
    }
  }
}

module.exports = {
  addClient,
  removeClient,
  sendToUser,
  sendPing,
};

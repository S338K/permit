const clients = new Map();

function addClient(userId, res) {
  if (!userId || !res) return;
  let set = clients.get(userId);
  if (!set) {
    set = new Set();
    clients.set(userId, set);
  }
  set.add(res);

  const cleanup = () => {
    try {
      removeClient(userId, res);
    } catch (e) {
      // Silently handle remove client errors
    }
  };

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
        if (res.destroyed || res.writableEnded || res.writableFinished) {
          removeClient(userId, res);
          continue;
        }

        res.write('event: notification\n');
        res.write(`data: ${data.replace(/\n/g, '\\n')}\n\n`);
      } catch (e) {
        try {
          removeClient(userId, res);
        } catch (err) {
          // Silently handle remove client errors
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
        res.write(': ping\n\n');
      } catch (e) {
        try {
          removeClient(userId, res);
        } catch (err) {
          // Silently handle remove client errors
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

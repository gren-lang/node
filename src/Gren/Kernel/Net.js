/*

import Gren.Kernel.Scheduler exposing (binding, succeed, fail, rawSpawn)
import Net exposing (NetError)
import Platform exposing (sendToApp)

*/

var _Net_nextSocketId = 0;

// `settings` is the plain Gren record Net.Settings built on the Gren side
// by decodeOptions (see src/Net.gren): defaults are applied there and the
// last occurrence of each option wins. Field accessors written with a
// double-underscore prefix are rewritten by the compiler to the mangled
// record field names (same convention as the Gren.Kernel.HttpClient
// config accessors).

function _Net_constructError(err) {
  return __Net_NetError({
    __$code: err.code || "",
    __$message: err.message || "",
  });
}

function _Net_applySocketOptions(socket, settings) {
  // Both are safe no-ops when left at their defaults (false / node default).
  socket.setNoDelay(settings.__$noDelay);
  socket.setKeepAlive(settings.__$keepAlive);
}

// Create a Gren Socket value backed by a node net.Socket. `socket` is a live
// node socket; `readBufferCapacity` configures the readable stream backlog.
function _Net_makeGrenSocket(socket, readBufferCapacity) {
  return {
    __$id: _Net_nextSocketId++,
    __$socket: socket,
    __$readable: _Net_buildReadable(socket, readBufferCapacity),
  };
}

// Build the ReadableStream that surfaces incoming bytes for a socket.
//
// Backpressure: the stream uses a CountQueuingStrategy with a configurable
// highWaterMark (readBufferCapacity). When the queue fills up, the socket is
// paused so the remote peer stops sending (TCP flow control kicks in). The
// pull callback resumes the socket when the consumer drains the queue below
// the capacity.
//
// A clean end of the input (remote FIN or full close) closes the stream, so
// readers observe `Stream.Closed`; a socket error errors the stream, so
// readers observe `Stream.Cancelled <message>`.
function _Net_buildReadable(socket, readBufferCapacity) {
  socket.__grenStreamClosed = false;

  var readable = new ReadableStream(
    {
      start: function (controller) {
        socket.__grenStreamController = controller;
      },
      pull: function () {
        socket.resume();
      },
    },
    new CountQueuingStrategy({ highWaterMark: readBufferCapacity }),
  );

  socket.on("data", function (chunk) {
    if (socket.__grenStreamClosed) return;

    socket.__grenStreamController.enqueue(
      new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength),
    );

    // If the readable buffer is full, pause the socket so the remote
    // peer stops sending. The pull callback above resumes it when the
    // consumer drains the queue.
    if (socket.__grenStreamController.desiredSize <= 0) {
      socket.pause();
    }
  });

  function closeStream() {
    // Close the stream so readers observe end-of-stream.
    if (!socket.__grenStreamClosed) {
      socket.__grenStreamClosed = true;
      try {
        socket.__grenStreamController.close();
      } catch (e) {
        // Controller may already be closed or errored; safe to ignore.
      }
    }
  }

  socket.on("end", closeStream);
  socket.on("close", closeStream);

  socket.on("error", function (err) {
    // Error the stream so active readers stop. Callers observe this as
    // Stream.Cancelled <message>.
    if (!socket.__grenStreamClosed) {
      socket.__grenStreamClosed = true;
      try {
        socket.__grenStreamController.error(err.message);
      } catch (e) {
        // Controller may already be closed or errored; safe to ignore.
      }
    }
  });

  return readable;
}

// CLIENT CONNECTIONS

var _Net_connect = F3(function (host, port, settings) {
  return __Scheduler_binding(function (callback) {
    var net = require("node:net");

    var called = false;

    function safeCallback(val) {
      if (!called) {
        called = true;
        callback(val);
      }
    }

    var socket = new net.Socket({
      allowHalfOpen: settings.__$allowHalfOpen,
    });
    var grenSocket = _Net_makeGrenSocket(
      socket,
      settings.__$readBufferCapacity,
    );

    socket.on("connect", function () {
      _Net_applySocketOptions(socket, settings);
      safeCallback(__Scheduler_succeed(grenSocket));
    });

    socket.on("error", function (err) {
      // Connection attempt failed (ECONNREFUSED, ETIMEDOUT, ...). If the
      // socket was already established the stream-error listener above has
      // taken care of the app side; safeCallback keeps this a no-op then.
      safeCallback(__Scheduler_fail(_Net_constructError(err)));
    });

    socket.connect(port, host);
  });
});

// SERVERS

var _Net_listen = F3(function (host, port, settings) {
  return __Scheduler_binding(function (callback) {
    var net = require("node:net");

    var called = false;

    function safeCallback(val) {
      if (!called) {
        called = true;
        callback(val);
      }
    }

    var server = net.createServer({
      allowHalfOpen: settings.__$allowHalfOpen,
    });
    server.__grenSettings = settings;

    server.on("error", function (err) {
      // Listen failures (EADDRINUSE, EACCES, ...) fail the task. Later
      // runtime errors are ignored once the task has settled.
      safeCallback(__Scheduler_fail(_Net_constructError(err)));
    });

    server.on("listening", function () {
      safeCallback(__Scheduler_succeed(server));
    });

    server.listen(port, host);
  });
});

// Initialize the handler storage on a listener object and attach the
// server-level "connection" listener exactly once. Per-socket handlers
// delegate to the current handler references stored on the listener object,
// so when onEffects updates the handlers, existing long-lived connections
// automatically use the new handlers.
function _Net_ensureListenersAttached(listener) {
  if (listener.__grenListenersAttached) {
    return;
  }
  listener.__grenListenersAttached = true;
  listener.__grenConnectionHandlers = [];
  listener.__grenCloseHandlers = [];

  listener.on("connection", function (socket) {
    var settings = listener.__grenSettings;
    _Net_applySocketOptions(socket, settings);
    var grenSocket = _Net_makeGrenSocket(
      socket,
      settings.__$readBufferCapacity,
    );

    // Notify the app of the new connection, if any handlers are registered.
    var connHandlers = listener.__grenConnectionHandlers;
    for (var i = 0; i < connHandlers.length; i++) {
      __Scheduler_rawSpawn(
        A2(
          __Platform_sendToApp,
          connHandlers[i].router,
          connHandlers[i].handler(grenSocket),
        ),
      );
    }

    socket.on("close", function () {
      var handlers = listener.__grenCloseHandlers;
      for (var j = 0; j < handlers.length; j++) {
        __Scheduler_rawSpawn(
          A2(
            __Platform_sendToApp,
            handlers[j].router,
            handlers[j].handler(grenSocket),
          ),
        );
      }
    });
  });
}

// Clear all stored handler references for a listener. Called once per
// listener at the start of each onEffects cycle, before re-adding current
// handlers.
var _Net_clearHandlers = function (listener) {
  _Net_ensureListenersAttached(listener);
  listener.__grenConnectionHandlers = [];
  listener.__grenCloseHandlers = [];
};

var _Net_setConnectionHandler = F3(function (listener, router, handler) {
  _Net_ensureListenersAttached(listener);
  listener.__grenConnectionHandlers.push({ router: router, handler: handler });
});

var _Net_setCloseHandler = F3(function (listener, router, handler) {
  _Net_ensureListenersAttached(listener);
  listener.__grenCloseHandlers.push({ router: router, handler: handler });
});

// SOCKET ACCESSORS

var _Net_getSocketId = function (socket) {
  return socket.__$id;
};

var _Net_getReadable = function (socket) {
  return socket.__$readable;
};

// SOCKET OPERATIONS

var _Net_write = F2(function (socket, bytes) {
  return __Scheduler_binding(function (callback) {
    var called = false;

    function safeCallback(val) {
      if (!called) {
        called = true;
        callback(val);
      }
    }

    try {
      var buffer = Buffer.from(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      socket.__$socket.write(buffer, function (err) {
        if (err) {
          safeCallback(__Scheduler_fail(_Net_constructError(err)));
        } else {
          safeCallback(__Scheduler_succeed({}));
        }
      });
    } catch (e) {
      safeCallback(__Scheduler_fail(_Net_constructError(e)));
    }
  });
});

var _Net_end = function (socket) {
  return __Scheduler_binding(function (callback) {
    var called = false;

    function safeCallback(val) {
      if (!called) {
        called = true;
        callback(val);
      }
    }

    if (socket.__$socket.destroyed) {
      callback(
        __Scheduler_fail(
          _Net_constructError({
            code: "ERR_STREAM_DESTROYED",
            message: "Socket destroyed",
          }),
        ),
      );
      return;
    }

    try {
      socket.__$socket.end(function (err) {
        // Mirror _Net_write: node surfaces e.g. ERR_STREAM_ALREADY_FINISHED
        // for a double end() through this callback, so it must fail the task.
        if (err) {
          safeCallback(__Scheduler_fail(_Net_constructError(err)));
        } else {
          safeCallback(__Scheduler_succeed({}));
        }
      });
    } catch (e) {
      safeCallback(__Scheduler_fail(_Net_constructError(e)));
    }
  });
};

var _Net_close = function (socket) {
  return __Scheduler_binding(function (callback) {
    try {
      socket.__$socket.destroy();
    } catch (e) {
      // Destroying an already-destroyed socket cannot meaningfully fail.
    }
    callback(__Scheduler_succeed({}));
  });
};

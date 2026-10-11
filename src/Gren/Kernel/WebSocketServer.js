/*

import Gren.Kernel.Scheduler exposing (binding, succeed, fail, rawSpawn, andThen, onError)
import Gren.Kernel.Net exposing (listen)
import Gren.Kernel.WebSocketCore exposing (attach)
import Gren.Kernel.WebSocketHandshake exposing (parseRequestHead, validateClientRequest, rejectResponse, acceptResponse)
import WebSocketServer exposing (ServerError, TextMessage, BinaryMessage)
import WebSocketServer.Connection as WsConn exposing (Error)
import Platform exposing (sendToApp)

*/

// RFC 6455 server, built on the shared engine (Gren.Kernel.WebSocketCore)
// and handshake helpers (Gren.Kernel.WebSocketHandshake) instead of the npm
// `ws` package. Layering (PLAN section 3): this kernel requires no node
// builtins itself; the listening socket comes from Gren.Kernel.Net.listen.
// The settings record that kernel consumes is the plain decoded-record
// shape Net.gren builds (field names written with the __$ prefix are
// mangled by the compiler the same way the accessor sites in Net.js are).

// A client that opens a connection but never completes the HTTP upgrade
// request is torn down after this window.
var _WebSocketServer_defaultHandshakeTimeoutMs = 60000;

// Accumulated request-head cap: a slow-loris style request cannot pin
// unbounded memory inside the timeout window.
var _WebSocketServer_MAX_HANDSHAKE_BYTES = 16384;

var _WebSocketServer_createServer = F3(function (host, port, settings) {
  // net-level settings: Net.gren's defaults. Per-connection socket options
  // are applied by _WebSocketServer_ensureListenersAttached (noDelay), and
  // the Net.Socket readable is never built here because the engine owns
  // each accepted socket's data events from attach() on.
  var netSettings = {
    __$keepAlive: false,
    __$noDelay: true,
    __$allowHalfOpen: false,
    __$readBufferCapacity: 16,
  };
  return A2(
    __Scheduler_onError,
    function (err) {
      // Listen failures (EADDRINUSE, EACCES, ...) fail the task, mirroring
      // the old `ws` server's "error" handling. Runtime errors after the
      // task settled are no-ops.
      return __Scheduler_fail(
        __WebSocketServer_ServerError({
          __$code: err.__$code || "UNKNOWN",
          __$message: err.__$message || "",
        }),
      );
    },
    A2(
      __Scheduler_andThen,
      function (server) {
        server.__grenWsSettings = settings;
        return __Scheduler_succeed(server);
      },
      A3(__Net_listen, host, port, netSettings),
    ),
  );
});

var _WebSocketServer_nextConnectionId = 0;

// Initialize the handler storage on a server object and attach the server-level
// "connection" listener exactly once. Per-client handlers delegate to the current
// handler references stored on the server object, so when onEffects updates the
// handlers, existing long-lived connections automatically use the new handlers.
function _WebSocketServer_ensureListenersAttached(server) {
  if (server.__grenListenersAttached) {
    return;
  }
  server.__grenListenersAttached = true;
  server.__grenConnectionHandlers = [];
  server.__grenCloseHandlers = [];

  server.on("connection", function (socket) {
    // Accept path: collect the HTTP upgrade request head, validate it, and
    // either reject with an HTTP error or send the 101 response and hand
    // the socket (plus any frame bytes already received) to the engine.
    var settings = server.__grenWsSettings;
    var timeoutMs =
      settings && settings.__$handshakeTimeout > 0
        ? settings.__$handshakeTimeout
        : _WebSocketServer_defaultHandshakeTimeoutMs;

    socket.setNoDelay(true);

    var chunks = [];
    var totalLength = 0;
    var settled = false;

    function cleanup() {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("end", onEndOrClose);
      socket.removeListener("close", onEndOrClose);
      socket.removeListener("error", onSocketError);
    }

    function reject(kind) {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        socket.write(__WebSocketHandshake_rejectResponse(kind));
        socket.end();
      } catch (e) {
        try {
          socket.destroy();
        } catch (e2) {
          // already gone
        }
      }
    }

    function destroy() {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        socket.destroy();
      } catch (e) {
        // already gone
      }
    }

    function onData(chunk) {
      totalLength += chunk.length;
      if (totalLength > _WebSocketServer_MAX_HANDSHAKE_BYTES) {
        destroy();
        return;
      }
      chunks.push(chunk);
      var buf = Buffer.concat(chunks);
      var sep = buf.indexOf("\r\n\r\n");
      if (sep === -1) {
        return;
      }
      var parsed = __WebSocketHandshake_parseRequestHead(
        buf.subarray(0, sep + 4),
      );
      if (!parsed.ok) {
        reject("BadRequest");
        return;
      }
      var check = __WebSocketHandshake_validateClientRequest(parsed);
      if (!check.ok) {
        reject(check.reject);
        return;
      }
      settled = true;
      cleanup();
      accept(parsed, buf.subarray(sep + 4));
    }

    function onEndOrClose() {
      // Peer went away before the request completed: nothing to answer.
      if (settled) return;
      settled = true;
      cleanup();
      try {
        socket.destroy();
      } catch (e) {
        // already gone
      }
    }

    function onSocketError() {
      // Error before the upgrade completed: tear the socket down; there is
      // no app-visible stream yet.
      destroy();
    }

    function accept(parsed, leftover) {
      var connection = {
        __$id: _WebSocketServer_nextConnectionId++,
        __$client: null,
        __$readable: null,
      };
      socket.__grenConnection = connection;

      socket.write(
        __WebSocketHandshake_acceptResponse(
          parsed.headers["sec-websocket-key"],
        ),
      );

      var handle = __WebSocketCore_attach(socket, {
        role: "server",
        readBufferCapacity:
          settings && settings.__$readBufferCapacity > 0
            ? settings.__$readBufferCapacity
            : 16,
        maxMessageSize: settings.__$maxMessageSize,
        maxFrameSize: settings.__$maxFrameSize,
        initialBytes: leftover,
        ctors: {
          text: function (view) {
            return __WebSocketServer_TextMessage(
              Buffer.from(
                view.buffer,
                view.byteOffset,
                view.byteLength,
              ).toString(),
            );
          },
          binary: function (view) {
            return __WebSocketServer_BinaryMessage(view);
          },
        },
        onClose: function (code, reason) {
          var handlers = server.__grenCloseHandlers;
          if (handlers.length === 0) return;
          var conn = socket.__grenConnection;
          if (!conn) return;
          for (var i = 0; i < handlers.length; i++) {
            __Scheduler_rawSpawn(
              A2(
                __Platform_sendToApp,
                handlers[i].router,
                A2(handlers[i].handler, conn, {
                  __$code: code,
                  __$reason: reason.toString(),
                }),
              ),
            );
          }
        },
      });

      connection.__$client = handle;
      connection.__$readable = handle.readable;

      // Notify the app of the new connection, if any handlers are registered.
      var connHandlers = server.__grenConnectionHandlers;
      for (var i = 0; i < connHandlers.length; i++) {
        __Scheduler_rawSpawn(
          A2(
            __Platform_sendToApp,
            connHandlers[i].router,
            connHandlers[i].handler(connection),
          ),
        );
      }
    }

    var timer = setTimeout(function () {
      destroy();
    }, timeoutMs);
    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }

    socket.on("data", onData);
    socket.on("end", onEndOrClose);
    socket.on("close", onEndOrClose);
    socket.on("error", onSocketError);
  });
}

// Clear all stored handler references for a server. Called once per server
// at the start of each onEffects cycle, before re-adding current handlers.
var _WebSocketServer_clearHandlers = function (server) {
  _WebSocketServer_ensureListenersAttached(server);
  server.__grenConnectionHandlers = [];
  server.__grenCloseHandlers = [];
};

var _WebSocketServer_setConnectionHandler = F3(
  function (server, router, handler) {
    _WebSocketServer_ensureListenersAttached(server);
    server.__grenConnectionHandlers.push({ router: router, handler: handler });
  },
);

var _WebSocketServer_setCloseHandler = F3(function (server, router, handler) {
  _WebSocketServer_ensureListenersAttached(server);
  server.__grenCloseHandlers.push({ router: router, handler: handler });
});

var _WebSocketServer_getConnectionId = function (connection) {
  return connection.__$id;
};

var _WebSocketServer_getReadable = function (connection) {
  return connection.__$readable;
};

function _WebSocketServer_constructError(err) {
  return __WsConn_Error({
    __$code: err.code || "",
    __$message: err.message || "",
  });
}

var _WebSocketServer_send = F2(function (connection, data) {
  return __Scheduler_binding(function (callback) {
    try {
      connection.__$client.sendText(data, function (err) {
        if (err) {
          callback(__Scheduler_fail(_WebSocketServer_constructError(err)));
        } else {
          callback(__Scheduler_succeed({}));
        }
      });
    } catch (e) {
      callback(__Scheduler_fail(_WebSocketServer_constructError(e)));
    }
  });
});

var _WebSocketServer_sendBytes = F2(function (connection, bytes) {
  return __Scheduler_binding(function (callback) {
    try {
      var buffer = Buffer.from(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      connection.__$client.sendBytes(buffer, function (err) {
        if (err) {
          callback(__Scheduler_fail(_WebSocketServer_constructError(err)));
        } else {
          callback(__Scheduler_succeed({}));
        }
      });
    } catch (e) {
      callback(__Scheduler_fail(_WebSocketServer_constructError(e)));
    }
  });
});

var _WebSocketServer_close = F3(function (connection, code, reason) {
  return __Scheduler_binding(function (callback) {
    try {
      connection.__$client.close(code, reason, function (err) {
        if (err) {
          callback(__Scheduler_fail(_WebSocketServer_constructError(err)));
        } else {
          callback(__Scheduler_succeed({}));
        }
      });
    } catch (e) {
      callback(__Scheduler_fail(_WebSocketServer_constructError(e)));
    }
  });
});

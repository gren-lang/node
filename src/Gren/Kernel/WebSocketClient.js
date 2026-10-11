/*

import Gren.Kernel.Scheduler exposing (binding, succeed, fail, rawSpawn, andThen, onError)
import Gren.Kernel.Net exposing (connect)
import Gren.Kernel.Tls exposing (secure)
import Gren.Kernel.WebSocketCore exposing (attach)
import Gren.Kernel.WebSocketHandshake exposing (parseWsUrl, buildClientRequest, validateServerResponse)
import WebSocketClient exposing (ConnectError, TextMessage, BinaryMessage)
import WebSocketClient.Connection as WsConn exposing (Error)
import Platform exposing (sendToApp)

*/

// RFC 6455 client, built on the shared engine (Gren.Kernel.WebSocketCore) and
// handshake helpers (Gren.Kernel.WebSocketHandshake) instead of the npm `ws`
// package. Layering (PLAN section 3): this kernel requires no node builtins
// itself; TCP connections go through Gren.Kernel.Net.connect and TLS
// upgrades through Gren.Kernel.Tls.secure. The settings records those
// kernels consume are the plain decoded-record shapes Net.gren / Tls.gren
// build (field names written with the __$ prefix are mangled by the
// compiler the same way the accessor sites in Net.js / Tls.js are).

var _WebSocketClient_nextConnectionId = 0;

// The client handshake must complete within this window or the connection
// attempt is failed and the socket torn down.
var _WebSocketClient_MAX_HANDSHAKE_TIMEOUT_MS = 10000;

// Accumulated handshake-response cap: a server that never finishes its
// header block cannot pin unbounded memory.
var _WebSocketClient_MAX_HANDSHAKE_BYTES = 16384;

function _WebSocketClient_constructConnectError(code, message) {
  return __WebSocketClient_ConnectError({
    __$code: code,
    __$message: message,
  });
}

// Map a NetError/TlsError record (same { code, message } shape) onto the
// ConnectError a failed connect task surfaces. Mirrors the old `ws`
// behavior of reporting the raw node error code (e.g. ECONNREFUSED).
function _WebSocketClient_errorToConnectError(err) {
  return __Scheduler_fail(
    _WebSocketClient_constructConnectError(
      (err && err.__$code) || "",
      (err && err.__$message) || "",
    ),
  );
}

var _WebSocketClient_connect = F2(function (url, settings) {
  var parsed = __WebSocketHandshake_parseWsUrl(url);
  if (!parsed.ok) {
    return __Scheduler_fail(
      _WebSocketClient_constructConnectError(
        parsed.error.code,
        parsed.error.message,
      ),
    );
  }

  // The net-level settings here are Net.gren's defaults: the WebSocket
  // client exposes no TCP-level options, and the readBufferCapacity that
  // would flow into a Net.Socket readable is meaningless here because the
  // WebSocket engine owns the socket's data events from attach() on.
  var netSettings = {
    __$keepAlive: false,
    __$noDelay: true,
    __$allowHalfOpen: false,
    __$readBufferCapacity: 16,
  };

  if (!parsed.isTls) {
    return A2(
      __Scheduler_onError,
      _WebSocketClient_errorToConnectError,
      A2(
        __Scheduler_andThen,
        function (grenSocket) {
          return _WebSocketClient_beginHandshake(
            grenSocket.__$socket,
            parsed,
            settings,
          );
        },
        A3(__Net_connect, parsed.host, parsed.port, netSettings),
      ),
    );
  }

  // wss://: TLS over the plain TCP connection. rejectUnauthorized stays on
  // (the old `ws` default): trust comes from node's default CA store, which
  // NODE_EXTRA_CA_CERTS can extend. servername follows the URL host; an IP
  // host is stripped SNI-side by _Tls_secure per RFC 6066.
  var tlsSettings = {
    __$ca: undefined,
    __$cert: undefined,
    __$key: undefined,
    __$rejectUnauthorized: true,
    __$servername: parsed.host,
    __$alpnProtocols: [],
  };

  return A2(
    __Scheduler_onError,
    _WebSocketClient_errorToConnectError,
    A2(
      __Scheduler_andThen,
      function (grenSocket) {
        // Drop the Net kernel's zombie stream listeners on the raw TCP
        // socket BEFORE the TLS upgrade attaches to it: nobody will ever
        // read that ReadableStream, and its backpressure pause would
        // stall the ciphertext flow (and thus TLS) once its queue fills.
        // Safe here because the TLS client always speaks first, so no
        // inbound bytes can be dropped in the gap; a no-op error listener
        // covers the one tick before tls.connect attaches its own.
        // removeAllListeners here is safe only under the client-speaks-first
        // TLS invariant (ClientHello before any server record); a future
        // server-first protocol or TLS extension (e.g. 0-RTT/early data)
        // must drain or preserve the zombie readable queue instead.
        grenSocket.__$socket.removeAllListeners();
        grenSocket.__$socket.on("error", function () {});
        return A2(
          __Scheduler_onError,
          _WebSocketClient_errorToConnectError,
          A2(
            __Scheduler_andThen,
            function (tlsGrenSocket) {
              return _WebSocketClient_beginHandshake(
                tlsGrenSocket.__$socket,
                parsed,
                settings,
              );
            },
            A2(__Tls_secure, grenSocket, tlsSettings),
          ),
        );
      },
      A3(__Net_connect, parsed.host, parsed.port, netSettings),
    ),
  );
});

// The HTTP/1.1 upgrade exchange on a connected (optionally TLS) socket:
// write the request, collect the response head, validate Sec-WebSocket-
// Accept, then hand the socket -- plus any bytes that already arrived past
// the header block -- to the framing engine.
function _WebSocketClient_beginHandshake(socket, parsed, settings) {
  return __Scheduler_binding(function (callback) {
    // The Net/Tls kernels installed readable-stream listeners on this
    // socket while establishing it; nobody will ever read those streams,
    // so drop every listener before the handshake (and later the engine)
    // takes ownership of the socket's data events.
    socket.removeAllListeners();

    var called = false;

    function safeCallback(val) {
      if (!called) {
        called = true;
        callback(val);
      }
    }

    var built = __WebSocketHandshake_buildClientRequest({
      host: parsed.host,
      port: parsed.port,
      pathWithQuery: parsed.pathWithQuery,
      isTls: parsed.isTls,
    });
    var key = built.key;

    var chunks = [];
    var totalLength = 0;
    var settled = false;

    function cleanup() {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("end", onEnd);
      socket.removeListener("close", onCloseEvent);
      socket.removeListener("error", onSocketError);
    }

    function failHandshake(code, message) {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        socket.destroy();
      } catch (e) {
        // already gone
      }
      safeCallback(
        __Scheduler_fail(_WebSocketClient_constructConnectError(code, message)),
      );
    }

    function onData(chunk) {
      totalLength += chunk.length;
      if (totalLength > _WebSocketClient_MAX_HANDSHAKE_BYTES) {
        failHandshake(
          "HandshakeError",
          "Handshake response exceeded " +
            _WebSocketClient_MAX_HANDSHAKE_BYTES +
            " bytes",
        );
        return;
      }
      chunks.push(chunk);
      var buf = Buffer.concat(chunks);
      var sep = buf.indexOf("\r\n\r\n");
      if (sep === -1) {
        return;
      }
      var result = __WebSocketHandshake_validateServerResponse(
        key,
        buf.subarray(0, sep + 4),
      );
      if (!result.ok) {
        failHandshake(result.error.code, result.error.message || "");
        return;
      }
      settled = true;
      cleanup();
      // cleanup removed the handshake error listener; cover the socket until
      // attach() installs the engine's own (which still drives app logic).
      socket.on("error", function () {});
      _WebSocketClient_startConnection(
        socket,
        settings,
        buf,
        sep + 4,
        safeCallback,
      );
    }

    function onEnd() {
      failHandshake(
        "HandshakeError",
        "Socket closed before handshake completed",
      );
    }

    function onCloseEvent() {
      failHandshake(
        "HandshakeError",
        "Socket closed before handshake completed",
      );
    }

    function onSocketError(err) {
      if (settled) return;
      settled = true;
      cleanup();
      safeCallback(
        __Scheduler_fail(
          _WebSocketClient_constructConnectError(
            err.code || "",
            err.message || "",
          ),
        ),
      );
    }

    var timer = setTimeout(function () {
      failHandshake("HandshakeError", "Handshake timed out");
    }, _WebSocketClient_MAX_HANDSHAKE_TIMEOUT_MS);
    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }

    socket.on("data", onData);
    socket.on("end", onEnd);
    socket.on("close", onCloseEvent);
    socket.on("error", onSocketError);

    socket.write(built.request);
  });
}

// Build the Connection value (and the engine handle behind it) once the
// handshake validated, then resolve the connect task. `headEnd` is the
// offset just past the handshake header block; bytes from there on are
// already-buffered frame bytes and go to the engine as initialBytes.
function _WebSocketClient_startConnection(
  socket,
  settings,
  buf,
  headEnd,
  safeCallback,
) {
  var writableController = null;

  function errorWritable(message) {
    if (writableController) {
      try {
        writableController.error(message);
      } catch (e) {
        // Controller may already be closed or errored; safe to ignore.
      }
    }
  }

  var connection = {
    __$id: _WebSocketClient_nextConnectionId++,
    __$client: null,
    __$readable: null,
    __$writable: null,
    __grenCloseHandlers: [],
  };

  // Writable stream for outgoing messages. Writing a Message value sends it
  // over the WebSocket; the write settles when the engine's write callback
  // fires, so backpressure from the socket propagates to writers.
  var sendStream = new WritableStream({
    start: function (controller) {
      writableController = controller;
    },
    write: function (chunk) {
      return new Promise(function (resolve, reject) {
        try {
          if (typeof chunk.a === "string") {
            connection.__$client.sendText(chunk.a, function (err) {
              if (err) {
                reject(err);
              } else {
                resolve();
              }
            });
          } else {
            var bytes = chunk.a;
            connection.__$client.sendBytes(
              Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
              function (err) {
                if (err) {
                  reject(err);
                } else {
                  resolve();
                }
              },
            );
          }
        } catch (e) {
          reject(e);
        }
      });
    },
  });

  connection.__$writable = sendStream;

  var handle = __WebSocketCore_attach(socket, {
    role: "client",
    readBufferCapacity: settings.__$readBufferCapacity,
    maxMessageSize: settings.__$maxMessageSize,
    maxFrameSize: settings.__$maxFrameSize,
    initialBytes: buf.subarray(headEnd),
    ctors: {
      text: function (view) {
        return __WebSocketClient_TextMessage(
          Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString(),
        );
      },
      binary: function (view) {
        return __WebSocketClient_BinaryMessage(view);
      },
    },
    onClose: function (code, reason) {
      // Error the writable so pending/future writers observe the close,
      // exactly like the old `ws` "close" handler did.
      errorWritable("WebSocket connection closed");

      var handlers = connection.__grenCloseHandlers;
      for (var i = 0; i < handlers.length; i++) {
        __Scheduler_rawSpawn(
          A2(
            __Platform_sendToApp,
            handlers[i].router,
            handlers[i].handler({
              __$code: code,
              __$reason: reason.toString(),
            }),
          ),
        );
      }
    },
    onError: function (message) {
      // The engine already errored the readable; the writable mirrors it so
      // writers stop, as in the old `ws` "error" handler.
      errorWritable(message);
    },
  });

  connection.__$client = handle;
  connection.__$readable = handle.readable;

  safeCallback(__Scheduler_succeed(connection));
}

// HANDLER MANAGEMENT

var _WebSocketClient_clearHandlers = function (connection) {
  connection.__grenCloseHandlers = [];
};

var _WebSocketClient_setCloseHandler = F3(
  function (connection, router, handler) {
    connection.__grenCloseHandlers.push({ router: router, handler: handler });
  },
);

// ACCESSORS

var _WebSocketClient_getConnectionId = function (connection) {
  return connection.__$id;
};

var _WebSocketClient_getReadable = function (connection) {
  return connection.__$readable;
};

var _WebSocketClient_getWritable = function (connection) {
  return connection.__$writable;
};

// CLOSING

function _WebSocketClient_constructError(err) {
  return __WsConn_Error({
    __$code: err.code || "",
    __$message: err.message || "",
  });
}

var _WebSocketClient_close = F3(function (connection, code, reason) {
  return __Scheduler_binding(function (callback) {
    try {
      connection.__$client.close(code, reason, function (err) {
        if (err) {
          callback(__Scheduler_fail(_WebSocketClient_constructError(err)));
        } else {
          callback(__Scheduler_succeed({}));
        }
      });
    } catch (e) {
      callback(__Scheduler_fail(_WebSocketClient_constructError(e)));
    }
  });
});

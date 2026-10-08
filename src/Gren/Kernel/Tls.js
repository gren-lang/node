/*

import Gren.Kernel.Scheduler exposing (binding, succeed, fail, rawSpawn)
import Tls exposing (TlsError)
import Platform exposing (sendToApp)

*/

var _Tls_nextSocketId = 0;

var _Tls_defaultReadBufferCapacity = 16;

// The settings arguments below are the plain Gren records Tls.ClientSettings
// and Tls.ServerSettings built on the Gren side by decodeClientOptions /
// decodeServerOptions (see src/Tls.gren): defaults are applied there and the
// last occurrence of each option wins. Field accessors written with a
// double-underscore prefix are rewritten by the compiler to the mangled
// record field names (same convention as the Gren.Kernel.Net settings
// accessors).

function _Tls_constructError(err) {
  return __Tls_TlsError({
    __$code: err.code || "",
    __$message: err.message || "",
  });
}

// Gren Bytes values arrive as DataViews; empty Bytes (byteLength 0) is the
// Gren-side encoding for "option not provided" and becomes undefined so node
// applies its own default instead.
function _Tls_bytesOrUndefined(bytes) {
  if (!bytes || bytes.byteLength === 0) {
    return undefined;
  }
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// Empty string / empty array on the Gren side likewise mean "not provided".
function _Tls_emptyToUndefined(value) {
  if (value === "" || (Array.isArray(value) && value.length === 0)) {
    return undefined;
  }
  return value;
}

// Create a Gren Socket value backed by a node tls.TLSSocket. `socket` is a
// live node TLS socket; `readBufferCapacity` configures the readable stream
// backlog.
function _Tls_makeGrenSocket(socket, readBufferCapacity) {
  return {
    __$id: _Tls_nextSocketId++,
    __$socket: socket,
    __$readable: _Tls_buildReadable(socket, readBufferCapacity),
  };
}

// Build the ReadableStream that surfaces incoming decrypted bytes for a
// socket.
//
// Backpressure: the stream uses a CountQueuingStrategy with a configurable
// highWaterMark (readBufferCapacity). When the queue fills up, the socket is
// paused — pause()/resume() on a tls socket flow control the underlying TCP
// connection, so the remote peer stops sending. The pull callback resumes
// the socket when the consumer drains the queue below the capacity.
//
// A clean end of the input (peer close_notify + FIN, or full close) closes
// the stream, so readers observe `Stream.Closed`; a socket error errors the
// stream, so readers observe `Stream.Cancelled <message>`.
function _Tls_buildReadable(socket, readBufferCapacity) {
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

// CLIENT

// Upgrade an already-connected TCP socket (the Gren Socket handed out by
// Net.connect) to TLS. The caller must not have used the Net.Socket's
// readable yet; it is discarded here and replaced by the TLS one built via
// _Tls_makeGrenSocket.
var _Tls_secure = F2(function (grenSocket, settings) {
  return __Scheduler_binding(function (callback) {
    var tls = require("node:tls");
    var net = require("node:net");

    var called = false;

    function safeCallback(val) {
      if (!called) {
        called = true;
        callback(val);
      }
    }

    // tls.connect({ socket }) on an already-destroyed TCP socket emits
    // nothing at all — no secureConnect, no tlsClientError, no close — so
    // the task would leak forever. Fail it up front, mirroring _Tls_end's
    // destroyed check.
    if (!grenSocket.__$socket || grenSocket.__$socket.destroyed) {
      safeCallback(
        __Scheduler_fail(
          _Tls_constructError({
            code: "ERR_STREAM_DESTROYED",
            message: "Socket destroyed",
          }),
        ),
      );
      return;
    }

    var servername = _Tls_emptyToUndefined(settings.__$servername);

    var options = {
      socket: grenSocket.__$socket,
      ca: _Tls_bytesOrUndefined(settings.__$ca),
      cert: _Tls_bytesOrUndefined(settings.__$cert),
      key: _Tls_bytesOrUndefined(settings.__$key),
      rejectUnauthorized: settings.__$rejectUnauthorized,
      servername: servername,
      ALPNProtocols: _Tls_emptyToUndefined(settings.__$alpnProtocols),
    };

    if (servername !== undefined && net.isIP(servername) > 0) {
      // RFC 6066 forbids an IP as the SNI name and node rejects an explicit
      // IP servername outright (with a deprecation today, an error in a
      // future release). Mirror what tls.connect({ host: ip }) does
      // internally: send no SNI, but still verify the certificate against
      // the IP subjectAltName entries. With rejectUnauthorized off, node
      // skips hostname verification entirely, so no check is installed.
      delete options.servername;
      if (settings.__$rejectUnauthorized) {
        options.checkServerIdentity = function (ignoredHostname, cert) {
          return tls.checkServerIdentity(servername, cert);
        };
      }
    }

    // Malformed PEM bytes in cert/key/ca make node throw *synchronously*
    // (ERR_OSSL_PEM_NO_START_LINE) — before any listener below can exist —
    // so the throw would escape the scheduler; route it to the task instead.
    var tlsSocket;
    try {
      tlsSocket = tls.connect(options);
    } catch (e) {
      safeCallback(__Scheduler_fail(_Tls_constructError(e)));
      return;
    }

    function onSecureConnect() {
      cleanup();
      safeCallback(
        __Scheduler_succeed(
          _Tls_makeGrenSocket(tlsSocket, _Tls_defaultReadBufferCapacity),
        ),
      );
    }

    function onHandshakeError(err) {
      cleanup();
      // Destroy the TLS socket (and with it the underlying TCP connection)
      // so a failed upgrade never leaks the file descriptor: the caller
      // only ever sees the failed task, not the socket handle.
      try {
        tlsSocket.destroy();
      } catch (e) {
        // Destroying an already-destroyed socket cannot meaningfully fail.
      }
      safeCallback(__Scheduler_fail(_Tls_constructError(err)));
    }

    function onPrematureClose() {
      // The underlying socket died before the handshake settled without
      // node ever emitting secureConnect or an error. Without this the task
      // would hang; guard the remaining silent-hang paths.
      cleanup();
      try {
        tlsSocket.destroy();
      } catch (e) {
        // Destroying an already-destroyed socket cannot meaningfully fail.
      }
      safeCallback(
        __Scheduler_fail(
          _Tls_constructError({
            code: "ERR_STREAM_DESTROYED",
            message: "Socket closed before the TLS handshake completed",
          }),
        ),
      );
    }

    function cleanup() {
      tlsSocket.removeListener("secureConnect", onSecureConnect);
      tlsSocket.removeListener("tlsClientError", onHandshakeError);
      tlsSocket.removeListener("error", onHandshakeError);
      tlsSocket.removeListener("close", onPrematureClose);
    }

    tlsSocket.on("secureConnect", onSecureConnect);
    // tlsClientError fires for handshake failures on client sockets; a plain
    // error (e.g. ECONNRESET mid-handshake) must fail the task too. Both are
    // removed once the task settles, after which _Tls_buildReadable's own
    // error listener owns the socket's error events.
    tlsSocket.on("tlsClientError", onHandshakeError);
    tlsSocket.on("error", onHandshakeError);
    // One-shot backstop: if the socket closes without the handshake ever
    // settling (silent-hang paths beyond tlsClientError/error), fail the
    // task instead of leaking it. Removed in cleanup() once settled.
    tlsSocket.on("close", onPrematureClose);
  });
});

// SERVERS

var _Tls_listen = F3(function (host, port, settings) {
  return __Scheduler_binding(function (callback) {
    var tls = require("node:tls");

    var called = false;

    function safeCallback(val) {
      if (!called) {
        called = true;
        callback(val);
      }
    }

    // Malformed PEM bytes make tls.createServer throw synchronously
    // (ERR_OSSL_PEM_NO_START_LINE) — the "error" listener below is not
    // registered yet, so the throw would escape the scheduler unnoticed.
    var server;
    try {
      server = tls.createServer({
        cert: _Tls_bytesOrUndefined(settings.__$cert),
        key: _Tls_bytesOrUndefined(settings.__$key),
        ca: _Tls_bytesOrUndefined(settings.__$ca),
        requestCert: settings.__$requestCert,
        ALPNProtocols: _Tls_emptyToUndefined(settings.__$alpnProtocols),
      });
    } catch (e) {
      safeCallback(__Scheduler_fail(_Tls_constructError(e)));
      return;
    }

    server.on("error", function (err) {
      // Listen failures (EADDRINUSE, EACCES, bad PEM data, ...) fail the
      // task. Later runtime errors are ignored once the task has settled.
      safeCallback(__Scheduler_fail(_Tls_constructError(err)));
    });

    // node emits tlsClientError on the server when a peer fails the TLS
    // handshake (e.g. a client that pins a different CA aborts mid-flight).
    // Without a listener this is an unhandled event; the app is not
    // interested — the failed socket never reaches onConnection.
    server.on("tlsClientError", function () {});

    server.on("listening", function () {
      safeCallback(__Scheduler_succeed(server));
    });

    server.listen(port, host);
  });
});

// Initialize the handler storage on a listener object and attach the
// server-level "secureConnection" listener exactly once. "secureConnection"
// (not "connection") fires only after the TLS handshake completes, so
// handlers never see half-negotiated sockets. Per-socket handlers delegate to
// the current handler references stored on the listener object, so when
// onEffects updates the handlers, existing long-lived connections
// automatically use the new handlers.
function _Tls_ensureListenersAttached(listener) {
  if (listener.__grenListenersAttached) {
    return;
  }
  listener.__grenListenersAttached = true;
  listener.__grenConnectionHandlers = [];
  listener.__grenCloseHandlers = [];

  listener.on("secureConnection", function (socket) {
    // Parity with accepted Net sockets, which get setNoDelay(true) via
    // _Net_applySocketOptions (Net's noDelay defaults to True). TLS's
    // ServerSettings intentionally has no TCP-tuning options, so apply
    // the same default here.
    socket.setNoDelay(true);

    var grenSocket = _Tls_makeGrenSocket(
      socket,
      _Tls_defaultReadBufferCapacity,
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
var _Tls_clearHandlers = function (listener) {
  _Tls_ensureListenersAttached(listener);
  listener.__grenConnectionHandlers = [];
  listener.__grenCloseHandlers = [];
};

var _Tls_setConnectionHandler = F3(function (listener, router, handler) {
  _Tls_ensureListenersAttached(listener);
  listener.__grenConnectionHandlers.push({ router: router, handler: handler });
});

var _Tls_setCloseHandler = F3(function (listener, router, handler) {
  _Tls_ensureListenersAttached(listener);
  listener.__grenCloseHandlers.push({ router: router, handler: handler });
});

// SOCKET ACCESSORS

var _Tls_getSocketId = function (socket) {
  return socket.__$id;
};

var _Tls_getReadable = function (socket) {
  return socket.__$readable;
};

// SOCKET OPERATIONS

var _Tls_write = F2(function (socket, bytes) {
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
          safeCallback(__Scheduler_fail(_Tls_constructError(err)));
        } else {
          safeCallback(__Scheduler_succeed({}));
        }
      });
    } catch (e) {
      safeCallback(__Scheduler_fail(_Tls_constructError(e)));
    }
  });
});

var _Tls_end = function (socket) {
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
          _Tls_constructError({
            code: "ERR_STREAM_DESTROYED",
            message: "Socket destroyed",
          }),
        ),
      );
      return;
    }

    try {
      // On a TLS socket, end() sends close_notify followed by FIN.
      socket.__$socket.end(function (err) {
        // Mirror _Tls_write: node surfaces e.g. ERR_STREAM_ALREADY_FINISHED
        // for a double end() through this callback, so it must fail the task.
        if (err) {
          safeCallback(__Scheduler_fail(_Tls_constructError(err)));
        } else {
          safeCallback(__Scheduler_succeed({}));
        }
      });
    } catch (e) {
      safeCallback(__Scheduler_fail(_Tls_constructError(e)));
    }
  });
};

var _Tls_close = function (socket) {
  return __Scheduler_binding(function (callback) {
    try {
      // Destroying a TLS socket also destroys its underlying TCP connection.
      socket.__$socket.destroy();
    } catch (e) {
      // Destroying an already-destroyed socket cannot meaningfully fail.
    }
    callback(__Scheduler_succeed({}));
  });
};

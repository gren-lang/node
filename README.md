# Gren on Node.js

This package allows you to create Gren programs that run on the Node.js runtime.

**I highly recommend working through the [guide](https://gren-lang.org/book/) to learn how to use Gren.**

## Creating a node application

In addition to [installing gren](https://gren-lang.org/install), you'll need the current [node LTS](https://nodejs.org/en) release.

Initialize a gren application that targets node:

```
gren init --platform=node
```

Create a `src/Main.gren` file:

```elm
module Main exposing (main)

import Node
import Stream
import Task

main =
    Node.defineSimpleProgram
        (\env ->
            Stream.sendLine env.stdout "Hello, World!"
                |> Task.execute
                |> Node.endWithCmd
        )
```

compile and run with

```
gren make src/Main.gren
node app
```

See the [cat example](https://github.com/gren-lang/example-projects/tree/main/cat) for a more complex example.

## Applications, sub-systems and permissions

This package is based around the idea of sub-systems. A sub-system provides access to functionality which interact with the outside world, like reading files or communicating with the terminal.

A sub-system must be initialized before the application is running. The result of initializing a sub-system is a permission value which needs to be passed in to the functions that the sub-system provides.

In other words, an application has to state up-front what permissions it requires.

Below is an example of initializing the `Terminal` and `FileSystem` sub-systems:

```gren
init
    : Environment
    -> Init.Task
        { model : Model
        , command : Cmd Msg
        }
init _env =
    Init.await Terminal.initialize <| \termConfig ->
    Init.await FileSystem.initialize <| \fsPermission ->
        Node.startProgram
            { model =
                { terminalConnection = Maybe.map .permission termConfig
                , fsPermission = fsPermission
                }
            , command =
                Cmd.none
            }
```

Once the permission value for each sub-system is stored in the model, your application can then interact with the terminal and file system.

Keep in mind that passing permissions to third-party code enables them to access these systems. Only give permissions to code you trust!

## WebSockets

This package ships first-class WebSocket support through the `WebSocketClient` and `WebSocketServer` modules. Both run on native kernel code built on the `Net` and `Tls` modules: framing, close handling, and UTF-8 validation are implemented directly in this package, so you do **not** need to install the `ws` npm package (applications that previously installed it as a workaround can now remove it).

A minimal server:

```gren
init env =
    Init.await WebSocketServer.initialize <| \permission ->
        WebSocketServer.createServer permission
            { host = "0.0.0.0", port_ = 8080, options = [] }
```

and a minimal client:

```gren
Init.await WebSocketClient.initialize <| \permission ->
    WebSocketClient.connect permission
        { url = "ws://localhost:8080", options = [] }
```

Once connected, incoming messages arrive on a `Stream.Readable` and outgoing messages go through a `Stream.Writable` from the connection modules (`WebSocketClient.Connection`, `WebSocketServer.Connection`).

### Backpressure

Read streams buffer messages using a `CountQueuingStrategy` with a high-water mark of `ReadBufferCapacity` messages (default 16). When the buffer is full, the kernel pauses the underlying socket and lets TCP flow control slow the remote peer down; reading a message resumes the flow. Writes backpressure through the writable side in the same way, so a slow reader cannot cause unbounded memory growth in either direction.

### Limits and options

Both modules accept `Option` values to tune behavior; the defaults below are what you get with `options = []`:

| Option               | Default                   | Applies to        |
| -------------------- | ------------------------- | ----------------- |
| `ReadBufferCapacity` | 16 messages               | client and server |
| `MaxMessageSize`     | 104857600 bytes (100 MiB) | client and server |
| `MaxFrameSize`       | 104857600 bytes (100 MiB) | client and server |
| `HandshakeTimeout`   | 60000 ms                  | server only       |

Messages or frames exceeding `MaxMessageSize`/`MaxFrameSize` close the connection with code `1009` (`TOO_LARGE`) as required by RFC 6455. On the server, sockets that fail to complete the HTTP upgrade within `HandshakeTimeout`, or that send more than 16 KiB of request head, are destroyed (slow-loris protection). The client's connect handshake timeout is fixed at 10 seconds.

### TLS

`wss://` client connections are fully supported with certificate verification against the Node.js trust store; for private CAs, use the standard `NODE_EXTRA_CA_CERTS` environment variable. Server-side TLS is not yet part of `WebSocketServer.createServer` — servers currently listen for `ws://` only.

### Notes and limitations

- Origin checking and subprotocol negotiation are not yet exposed as options.
- The `permessage-deflate` extension is not supported.
- The `Net`, `Net.Socket`, `Tls`, and `Tls.Socket` modules are exposed by this package and can be used directly by other libraries and applications.

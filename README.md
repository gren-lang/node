# Gren on NodeJS

This package allows you to create Gren programs that run on the NodeJS runtime.

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

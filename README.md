# Gren on NodeJS

This package allows you to create Gren programs that run on the NodeJS runtime.

**I highly recommend working through the [guide](https://gren-lang.org/book/) to learn how to use Gren.**

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

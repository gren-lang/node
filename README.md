# Gren on NodeJS

This package allows you to create Gren programs that on desktops using the NodeJS runtime.

**I highly recommend working through [gren-lang.org/learn][guide] to learn how to use Gren.**

## Sub-systems and permissions

This package is based around the idea of sub-systems. A sub-system provides access to functionality which interact with the operating system, like reading files or communicating with the terminal.

A sub-system must be initialized before used. The result of initializing a sub-system is a permission value which needs to be passed in to the functions that the sub-system provides.

Below is an example of initializing the `Terminal` and `FileSystem` sub-systems:

```gren
init :
    Node.Program.AppInitTask
        { model : Model
        , command : Cmd Msg
        }
init =
    Node.Program.await Terminal.initialize \termConfig ->
    Node.Program.await FileSystem.initialize \fsPermission ->
        Node.Program.startProgram
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

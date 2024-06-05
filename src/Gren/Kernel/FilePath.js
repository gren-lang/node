/*
*/

var path = require("node:path");
var process = require("node:process");

var _FilePath_fromPosix = function (str) {
  return _FilePath_parse(path.posix, str);
};

var _FilePath_fromWin32 = function (str) {
  return _FilePath_parse(path.win32, str);
};

var _FilePath_fromString = function (str) {
  return _FilePath_parse(path, str);
};

var _FilePath_parse = function (pathMod, str) {
  const result = pathMod.parse(pathMod.normalize(str));

  const root = result.root;
  const dirStr = result.dir.startsWith(root)
    ? result.dir.substring(root.length)
    : result.dir;

  const filename =
    result.name === "." && result.ext.length === 0 ? "" : result.name;

  return {
    __$directory: dirStr === "" ? [] : dirStr.split(pathMod.sep),
    __$extension: result.ext.length > 0 ? result.ext.substring(1) : "",
    __$filename: filename,
    __$root: result.root,
  };
};

var _FilePath_toPosix = function (filePath) {
  if (_FilePath_isEmpty(filePath)) {
    return ".";
  }

  if (filePath.__$root !== "" && filePath.__$root !== "/") {
    filePath = { ...filePath, __$root: "/" };
  }

  return _FilePath_format(path.posix, filePath);
};

var _FilePath_toWin32 = function (filePath) {
  if (_FilePath_isEmpty(filePath)) {
    return ".";
  }

  return _FilePath_format(path.win32, filePath);
};

var _FilePath_toString = function (filePath) {
  if (process.platform.toLowerCase() === "win32") {
    return _FilePath_toWin32(filePath);
  }

  return _FilePath_toPosix(filePath);
};

var _FilePath_isEmpty = function (filePath) {
  return (
    filePath.__$root === "" &&
    filePath.__$directory.length === 0 &&
    filePath.__$filename === "" &&
    filePath.__$extension === ""
  );
};

var _FilePath_format = function (pathMod, filePath) {
  const filename =
    filePath.__$extension.length > 0
      ? filePath.__$filename + "." + filePath.__$extension
      : filePath.__$filename;

  let pathArray = null;
  if (filename === "") {
    pathArray = filePath.__$directory;
  } else {
    pathArray = filePath.__$directory.concat(filename);
  }

  return filePath.__$root + pathArray.join(pathMod.sep);
};

{ pkgs, lib, config, inputs, ... }:

let
  gren = inputs.gren.packages.${pkgs.stdenv.system}.default;
in
{
  packages = [
    pkgs.nodejs_20
    pkgs.nodePackages.prettier
    gren
  ];

  enterShell = ''
    echo "gren version: $(gren --version)"
  '';

  enterTest = ''
    echo "Please run 'devenv task run test' instead"
    exit 1
  '';

  tasks = {
    "format:run".exec = "prettier -w \"!**/*.json\" .";
    "format:check".exec =  "prettier -c \"!**/*.json\" .";

    "test:unit".exec = ''
      cd tests/
      ./run-tests.sh
    '';

    "test:integration".exec = ''
      cd integration-tests/
      ./run-tests.sh
    '';
  };
}

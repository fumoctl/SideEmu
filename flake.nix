{
  description = "Sidemu — Self-contained mobile device mirroring & MCP server extension for VSCodium / VS Code";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      linuxSystems = [ "x86_64-linux" "aarch64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (s: f s);
      forLinux = f: nixpkgs.lib.genAttrs linuxSystems (s: f s);
      pkgsFor = system: import nixpkgs {
        inherit system;
        config = {
          allowUnfree = true;
          android_sdk.accept_license = true;
        };
      };
      androidFor =
        { pkgs
        , platformVersion ? "34"
        , systemImageType ? "google_apis"
        , abiVersion ? (if pkgs.stdenv.hostPlatform.isAarch64 then "arm64-v8a" else "x86_64")
        }:
        pkgs.androidenv.composeAndroidPackages {
          platformVersions = [ platformVersion ];
          includeEmulator = true;
          includeSystemImages = true;
          systemImageTypes = [ systemImageType ];
          abiVersions = [ abiVersion ];
          includeNDK = false;
        };
    in
    {
      lib = {
        mkSidebarEmulator =
          { system
          , pkgs ? pkgsFor system
          , name ? "sidemu"
          , platformVersion ? "34"
          , systemImageType ? "google_apis"
          , abiVersion ? (if pkgs.stdenv.hostPlatform.isAarch64 then "arm64-v8a" else "x86_64")
          , device ? "pixel_6"
          , gpu ? "auto"
          , extraEmulatorArgs ? [ ]
          }:
          let
            android = androidFor { inherit pkgs platformVersion systemImageType abiVersion; };
            sdk = android.androidsdk;
            ldLibPath = pkgs.lib.makeLibraryPath [ pkgs.vulkan-loader pkgs.libGL ];
          in
          (pkgs.writeShellApplication {
            name = "sidemu-emulator";
            runtimeInputs = [ sdk pkgs.coreutils ];
            text = ''
              export ANDROID_SDK_ROOT="${sdk}/libexec/android-sdk"
              export ANDROID_HOME="$ANDROID_SDK_ROOT"
              export ANDROID_AVD_HOME="''${XDG_CACHE_HOME:-$HOME/.cache}/nix-avd/${name}"
              export ANDROID_USER_HOME="$ANDROID_AVD_HOME/user-home"
              mkdir -p "$ANDROID_AVD_HOME" "$ANDROID_USER_HOME"

              if [ ! -f "$ANDROID_AVD_HOME/${name}.ini" ]; then
                avdmanager create avd --force --name "${name}" \
                  --package "system-images;android-${platformVersion};${systemImageType};${abiVersion}" \
                  --device "${device}" <<< "no"
                echo "hw.keyboard=yes" >> "$ANDROID_AVD_HOME/${name}.avd/config.ini"
              fi

              export LD_LIBRARY_PATH="${ldLibPath}''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

              # Ensure an adb server (same version as this SDK) is running so the emulator registers
              # on 127.0.0.1:5037 and Sidemu / mobilecli can discover it.
              adb start-server >/dev/null 2>&1 || true

              args=(-avd "${name}" -gpu "${gpu}")
              if [ "''${SIDEMU_ACTIVE:-}" = "1" ]; then
                args+=(-no-window -no-audio -no-boot-anim)
              fi

              exec emulator "''${args[@]}" ${pkgs.lib.escapeShellArgs extraEmulatorArgs} "$@"
            '';
          }).overrideAttrs (old: {
            passthru = (old.passthru or { }) // {
              platformTools = android.platform-tools;
              androidsdk = sdk;
            };
          });
      };

      devShells = forAll (system:
        let
          pkgs = pkgsFor system;
          platformTools = (androidFor { inherit pkgs; }).platform-tools;
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs_22
              typescript
              vsce
              jq
              unzip
              git
              platformTools
            ];
            ANDROID_HOME = "${platformTools}/libexec/android-sdk";
            ANDROID_SDK_ROOT = "${platformTools}/libexec/android-sdk";
            shellHook = ''
              export PATH="$PWD/node_modules/.bin:$PATH"
            '';
          };
        });

      packages = forLinux (system: {
        android-emulator = self.lib.mkSidebarEmulator { inherit system; };
      });

      apps = forLinux (system: {
        android-emulator = {
          type = "app";
          program = "${self.packages.${system}.android-emulator}/bin/sidemu-emulator";
        };
      });
    };
}
